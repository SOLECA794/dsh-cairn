/**
 * Project verify routes — "touch X, therefore run Y", declared by the repo and
 * checked by machine instead of by prose.
 *
 * A `AGENTS.md` can say *run the kernel regression after touching
 * `src/kernel/**`*; nothing enforces it. This module turns that sentence into
 * data:
 *
 * ```json
 * {
 *   "test": "bash tools/regress-rv64.sh",
 *   "build": "make ARCH=riscv64 build",
 *   "routes": [
 *     { "match": "src/kernel/**", "run": "bash tools/regress-rv64.sh" },
 *     { "match": "src/driver/**", "run": "make ARCH=riscv64 build" }
 *   ]
 * }
 * ```
 *
 * Two deliberate departures from the design this was modelled on:
 *
 * 1. **Nothing here spawns.** The declared string is a *reminder*, never an
 *    execution channel. A path-glob-to-command mapping read out of repository
 *    content is arbitrary code; the harness already has one place that runs
 *    commands (the shell tool, with the user's permission preset) and adding a
 *    second silent one is how a supply-chain bug becomes a remote shell. So the
 *    trust gate that design needed does not exist here, because the capability
 *    it gated does not exist either.
 * 2. **Config is scoped to the project root only.** No user-global fallback:
 *    a route means "this repository wants this check", and inheriting one from
 *    `~` would make the same working tree behave differently on two machines.
 */

import { readFileSync, statSync } from 'node:fs'
import { resolve } from 'node:path'
import { clampInt, globToRegExp, isAbsolutePath, isGlobMatch, readJsonSafe, toPosix, toRootRelative } from './core.js'

/** Where a project declares its checks, relative to the repository root. */
export const VERIFY_CONFIG_PATH = '.cairn/verify.json'

/** The four kinds a declared command can be classified into. */
export const VERIFY_KINDS = Object.freeze(['test', 'build', 'typecheck', 'lint'])

export const VERIFY_DEFAULTS = Object.freeze({
  /** Cap on declared routes honoured from one file; a runaway config is not a plan. */
  maxRoutes: 64,
  /** Cap on the length of a single declared command. */
  maxCommandChars: 500,
  /** Cap on declared ignore globs. */
  maxIgnore: 64
})

/** Why a config file was rejected. `ok: false` configs are treated as absent. */
function reject(reason) {
  return { ok: false, reason, config: emptyConfig() }
}

function emptyConfig() {
  return { test: undefined, build: undefined, typecheck: undefined, lint: undefined, routes: [], ignore: [] }
}

function readCommand(value, field) {
  if (value === undefined || value === null) return { value: undefined }
  if (typeof value !== 'string') return { error: `${field} must be a string` }
  const trimmed = value.trim()
  if (trimmed.length === 0) return { value: undefined }
  if (trimmed.length > VERIFY_DEFAULTS.maxCommandChars) {
    return { error: `${field} is longer than ${VERIFY_DEFAULTS.maxCommandChars} characters` }
  }
  // A declared command is shown to the model verbatim. Newlines would let it
  // impersonate multiple commands or a new instruction block.
  if (/[\r\n]/.test(trimmed)) return { error: `${field} must be a single line` }
  return { value: trimmed }
}

/**
 * Validate one parsed config object. Returns `{ok, reason?, config}` and never
 * throws — a broken declaration degrades to "no routes", not to a failing turn.
 */
export function parseVerifyConfig(raw) {
  if (raw === undefined || raw === null) return { ok: true, config: emptyConfig() }
  if (typeof raw !== 'object' || Array.isArray(raw)) return reject('config must be a JSON object')

  const config = emptyConfig()
  for (const kind of VERIFY_KINDS) {
    const read = readCommand(raw[kind], kind)
    if (read.error) return reject(read.error)
    config[kind] = read.value
  }

  const routes = raw.routes
  if (routes !== undefined && routes !== null) {
    if (!Array.isArray(routes)) return reject('routes must be an array')
    if (routes.length > VERIFY_DEFAULTS.maxRoutes) {
      return reject(`routes has ${routes.length} entries; the cap is ${VERIFY_DEFAULTS.maxRoutes}`)
    }
    const seen = new Set()
    for (const [index, route] of routes.entries()) {
      if (route === null || typeof route !== 'object' || Array.isArray(route)) {
        return reject(`routes[${index}] must be an object`)
      }
      const match = typeof route.match === 'string' ? route.match.trim() : ''
      if (match.length === 0) return reject(`routes[${index}].match must be a non-empty glob`)
      // Compile now so a malformed glob is a config error, not a silent skip at
      // gate time. A route that cannot be matched would never fire, and the
      // failure would look like "the repo does not care about this path".
      try {
        globToRegExp(match)
      } catch (error) {
        return reject(`routes[${index}].match is not a valid glob: ${error.message}`)
      }
      const run = readCommand(route.run, `routes[${index}].run`)
      if (run.error) return reject(run.error)
      if (run.value === undefined) return reject(`routes[${index}].run must be a non-empty command`)
      const key = `${match}\u0000${run.value}`
      if (seen.has(key)) continue
      seen.add(key)
      const entry = { match, run: run.value }
      if (typeof route.note === 'string' && route.note.trim().length > 0) {
        entry.note = route.note.trim().slice(0, 200)
      }
      config.routes.push(entry)
    }
  }

  const ignore = raw.ignore
  if (ignore !== undefined && ignore !== null) {
    if (!Array.isArray(ignore)) return reject('ignore must be an array')
    if (ignore.length > VERIFY_DEFAULTS.maxIgnore) {
      return reject(`ignore has ${ignore.length} entries; the cap is ${VERIFY_DEFAULTS.maxIgnore}`)
    }
    const seenGlobs = new Set()
    for (const [index, entry] of ignore.entries()) {
      if (typeof entry !== 'string' || entry.trim().length === 0) {
        return reject(`ignore[${index}] must be a non-empty glob`)
      }
      const glob = entry.trim()
      try {
        globToRegExp(glob)
      } catch (error) {
        return reject(`ignore[${index}] is not a valid glob: ${error.message}`)
      }
      if (seenGlobs.has(glob)) continue
      seenGlobs.add(glob)
      config.ignore.push(glob)
    }
  }

  return { ok: true, config }
}

/**
 * Paths a project does not count as part of the deliverable — a scratch
 * directory, build output, one-shot patch scripts. They are still observed;
 * they just never become files *this session changed*, so they cannot pad the
 * readiness list or hold the gate.
 *
 * This exists because a replay of a real kernel session found that 121 of 163
 * injected notices named a throwaway script under a scratch directory, and the
 * readiness list only has room for six files.
 */
export function isIgnored(path, config) {
  const globs = Array.isArray(config?.ignore) ? config.ignore : []
  if (globs.length === 0) return false
  if (typeof path !== 'string' || path.length === 0) return false
  return globs.some((glob) => isGlobMatch(glob, path))
}

/** Memo keyed on path + mtime + size, so an edit mid-session is picked up. */
const memo = new Map()

/**
 * Load the declaration for a working directory. Search order is exactly one
 * place: `<root>/.cairn/verify.json`. Returns `{ok, config, path?, reason?}`.
 */
export function loadVerifyConfig(root, { fresh = false } = {}) {
  if (typeof root !== 'string' || root.length === 0) {
    return { ok: true, config: emptyConfig(), path: undefined }
  }
  const path = resolve(root, VERIFY_CONFIG_PATH)
  let stamp
  try {
    const stat = statSync(path)
    stamp = `${stat.mtimeMs}:${stat.size}`
  } catch {
    memo.delete(path)
    return { ok: true, config: emptyConfig(), path: undefined }
  }
  if (!fresh) {
    const hit = memo.get(path)
    if (hit !== undefined && hit.stamp === stamp) return hit.result
  }
  let result
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'))
    result = { ...parseVerifyConfig(parsed), path }
  } catch (error) {
    result = { ok: false, reason: `unreadable config: ${error.message}`, config: emptyConfig(), path }
  }
  memo.set(path, { stamp, result })
  return result
}

/** Drop the memo (tests, or after writing the file from a tool). */
export function invalidateVerifyConfig(root) {
  if (root === undefined) memo.clear()
  else memo.delete(resolve(root, VERIFY_CONFIG_PATH))
}

/**
 * Does running `command` satisfy the check declared as `declared`?
 *
 * The rule is: the declared command matches exactly, or the invocation is the
 * declared command followed by flags / `KEY=value` assignments. Not "any prefix
 * followed by anything", because that direction is the expensive one:
 *
 * - `bash tools/regress.sh` declared, `bash tools/regress.sh --fast` run →
 *   satisfied.
 * - `make` declared, `make clean` run → **not** satisfied. `make clean` deletes
 *   the build tree; treating a zero exit from it as "the build passed" is
 *   precisely the false verification the ledger exists to prevent, and it would
 *   open the gate on a lie.
 *
 * The cost of the strict rule is the opposite error: `pytest` declared and
 * `pytest tests/one.py` run reads as unverified. That is noisy but safe — the
 * reminder says no declared check has run, and the fix is for the repo to declare
 * the check it actually runs.
 *
 * Known limitation, stated rather than hidden: a *narrowing flag* is accepted, so
 * `pytest -k smoke` counts against a declared `pytest`. Flag semantics are not
 * knowable from a string, and guessing wrong here in the other direction would
 * reject `cargo check --all-targets`, which is strictly broader. The ledger keeps
 * the full command text, so an auditor can see which invocation produced a pass.
 *
 * Substring matching is not used at all: `cmake build` must never match a
 * declared `make`.
 */
export function commandSatisfies(declared, command) {
  if (typeof declared !== 'string') return false
  if (typeof command !== 'string') return false
  const base = declared.trim()
  const cmd = command.trim()
  if (base.length === 0 || cmd.length === 0) return false
  if (cmd === base) return true
  if (!cmd.startsWith(`${base} `)) return false
  const rest = cmd.slice(base.length + 1).trim()
  if (rest.length === 0) return true
  const first = rest.split(/\s+/)[0]
  return first.startsWith('-') || /^[A-Za-z_][A-Za-z0-9_]*=/.test(first)
}

/** Classify a command string against the declared kinds. */
export function classifyCommand(command, config) {
  if (typeof command !== 'string' || command.length === 0) return undefined
  if (command.trim().length === 0) return undefined
  for (const kind of VERIFY_KINDS) {
    if (commandSatisfies(config?.[kind], command)) return kind
  }
  return undefined
}

/** Does a command string run one of the declared routes? */
export function classifyRouteCommand(command, config) {
  if (typeof command !== 'string' || command.length === 0) return undefined
  for (const route of config?.routes ?? []) {
    if (commandSatisfies(route.run, command)) return route
  }
  return undefined
}

/**
 * Routes whose glob hits at least one changed file.
 *
 * Paths are compared as repo-relative POSIX. A relative path is taken at face
 * value; an absolute path is converted when it is under the root and dropped
 * when it is not, because a path outside the root cannot be matched against a
 * root-relative glob and silently treating it as relative would fire the wrong
 * route.
 */
export function matchRoutes(changedFiles, routes, { root } = {}) {
  if (!Array.isArray(routes) || routes.length === 0) return []
  if (!Array.isArray(changedFiles) || changedFiles.length === 0) return []
  const files = []
  for (const file of changedFiles) {
    if (typeof file !== 'string' || file.length === 0) continue
    // Already relative: the caller read it out of the ledger, and re-relativising
    // it would drop it (a relative path is not under an absolute root), which
    // silently matched nothing for every `cairn_routes { files: [...] }` call.
    if (!isAbsolutePath(file)) {
      files.push(toPosix(file))
      continue
    }
    const rel = root === undefined ? null : toRootRelative(root, file)
    if (rel !== null) files.push(rel)
  }
  if (files.length === 0) return []
  const out = []
  const seen = new Set()
  for (const route of routes) {
    const key = `${route.match}\u0000${route.run}`
    if (seen.has(key)) continue
    if (files.some((file) => isGlobMatch(route.match, file))) {
      seen.add(key)
      out.push(route)
    }
  }
  return out
}

/** Human summary of what a project declared, for a startup log line. */
export function describeVerifyConfig(config) {
  const kinds = VERIFY_KINDS.filter((kind) => typeof config?.[kind] === 'string')
  const routes = config?.routes?.length ?? 0
  const ignored = config?.ignore?.length ?? 0
  if (kinds.length === 0 && routes === 0) return ignored === 0 ? 'none declared' : `ignore x${ignored}`
  const parts = []
  if (kinds.length > 0) parts.push(kinds.join('/'))
  if (routes > 0) parts.push(`${routes} route${routes === 1 ? '' : 's'}`)
  if (ignored > 0) parts.push(`ignore x${ignored}`)
  return parts.join(' + ')
}

/**
 * The reminder block injected into the system prompt. Kept short on purpose:
 * this text is paid for on every request, and a page of prose would cost more
 * than the verification it asks for.
 */
export function renderVerifyHint(config, { maxRoutes = 8 } = {}) {
  if (config === undefined || config === null) return ''
  const kinds = VERIFY_KINDS.filter((kind) => typeof config[kind] === 'string')
  const routes = config.routes ?? []
  if (kinds.length === 0 && routes.length === 0) return ''
  const lines = ['<project-checks>', 'This repository declares machine-checkable verification:']
  for (const kind of kinds) lines.push(`- ${kind}: \`${config[kind]}\``)
  if (routes.length > 0) {
    const shown = routes.slice(0, clampInt(maxRoutes, 1, VERIFY_DEFAULTS.maxRoutes, 8))
    lines.push('- path routes (run these after changing a matching file):')
    for (const route of shown) lines.push(`  - \`${route.match}\` → \`${route.run}\``)
    if (routes.length > shown.length) lines.push(`  - … ${routes.length - shown.length} more`)
  }
  lines.push(
    'Claiming work is done without running the matching check is a false report. ' +
      'Run the check, then state the command and its exit code.'
  )
  lines.push('</project-checks>')
  return lines.join('\n')
}
