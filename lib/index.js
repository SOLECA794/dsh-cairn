/**
 * dsh-cairn — a persistent route marker for coding sessions.
 *
 * A cairn is a stack of stones each traveller adds so the next one can find the
 * path. This plugin does the same three things for a repository:
 *
 *   1. It reads the checks a project already declares (`.cairn/verify.json`)
 *      and tells the agent which one applies to the files it just changed.
 *      It never runs them: the shell tool is the only thing in this harness
 *      that executes commands, and adding a second silent one is how a
 *      supply-chain bug becomes a remote shell.
 *
 *   2. It keeps a per-session ledger of what was written and what was verified,
 *      and attributes every verification to the writes it actually covers.
 *      A check that ran *before* the last edit proves nothing about that edit,
 *      so the ledger compares timestamps per file instead of counting.
 *
 *   3. It leaves and reads decaying signals on paths across sessions, so the
 *      next session inherits "this file is fragile" without inheriting a
 *      transcript.
 *
 * Cost model: this plugin saves no tokens. It spends a few hundred characters
 * per injection and buys a smaller chance of an unverified "done". That is the
 * trade it exists to make, and `gate.mode: 'off'` turns the spending off
 * without touching the accounting.
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'

import { findAncestorWith, hashShort, isGlobMatch, stableId, toRootRelative } from './core.js'
import { createLedger } from './ledger.js'
import {
  PHEROMONE_HALF_LIVES,
  PHEROMONE_SIGNALS,
  createPheromoneStore
} from './pheromone.js'
import { buildReadinessReminder, buildStepReminder } from './remind.js'
import {
  VERIFY_CONFIG_PATH,
  VERIFY_KINDS,
  classifyCommand,
  classifyRouteCommand,
  commandSatisfies,
  describeVerifyConfig,
  isIgnored,
  loadVerifyConfig,
  matchRoutes,
  renderVerifyHint
} from './verify.js'

export const name = 'dsh-cairn'

/** @type {string[]} */
export const inject = ['tools']

/* ------------------------------------------------------------------ *
 * Configuration
 * ------------------------------------------------------------------ */

const GATE_MODES = new Set(['remind', 'deny', 'off'])

export const CAIRN_DEFAULTS = Object.freeze({
  /** Master switch for the accounting. Turning this off disables everything. */
  enabled: true,
  /** Whether to look for `.cairn/verify.json` at all. */
  verify: true,
  /** `remind` injects; `deny` also refuses the finalize tools; `off` is silent. */
  gateMode: 'remind',
  /** Tools whose invocation is a delivery claim, so the gate can hold them. */
  gateTools: Object.freeze(['present']),
  /** Shell commands the gate may hold when `gateMode` is `deny`. */
  gateCommands: Object.freeze(['git commit', 'git push']),
  /** Turn the reminder off without turning the ledger off. */
  injectReadiness: true,
  /** Pheromones persist per project under the DSH home. */
  pheromoneEnabled: true,
  pheromonePersist: true,
  /** Deposit automatically from observed evidence. */
  autoDeposit: true,
  /** A file edited this many times in one session is worth marking fragile. */
  fragileWrites: 3,
  /** A path read this many times in one session is likely an entry point. */
  entryPointReads: 3
})

function firstString(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.length > 0) return value
  }
  return undefined
}

function toBool(value, fallback) {
  if (typeof value === 'boolean') return value
  return fallback
}

function toPositiveInt(value, fallback, max) {
  const n = Number(value)
  if (!Number.isFinite(n) || n <= 0) return fallback
  return Math.min(Math.trunc(n), max)
}

function toGlobList(value, fallback) {
  if (Array.isArray(value)) {
    const out = value.filter((item) => typeof item === 'string' && item.length > 0)
    if (out.length > 0) return out
  }
  return [...fallback]
}

/** Accept both a nested object and the flatter shape a YAML row encourages. */
export function normalizeConfig(raw = {}) {
  const source = raw !== null && typeof raw === 'object' ? raw : {}
  const gate = source.gate !== null && typeof source.gate === 'object' ? source.gate : {}
  const pheromone = source.pheromone !== null && typeof source.pheromone === 'object' ? source.pheromone : {}
  const mode = firstString(gate.mode, source.gateMode)
  return {
    enabled: toBool(source.enabled, CAIRN_DEFAULTS.enabled),
    verify: toBool(source.verify, CAIRN_DEFAULTS.verify),
    gateMode: GATE_MODES.has(mode) ? mode : CAIRN_DEFAULTS.gateMode,
    gateTools: toGlobList(gate.tools ?? source.gateTools, CAIRN_DEFAULTS.gateTools),
    gateCommands: toGlobList(gate.commands ?? source.gateCommands, CAIRN_DEFAULTS.gateCommands),
    injectReadiness: toBool(source.injectReadiness, CAIRN_DEFAULTS.injectReadiness),
    pheromoneEnabled: toBool(pheromone.enabled ?? source.pheromoneEnabled, CAIRN_DEFAULTS.pheromoneEnabled),
    pheromonePersist: toBool(pheromone.persist ?? source.pheromonePersist, CAIRN_DEFAULTS.pheromonePersist),
    autoDeposit: toBool(source.autoDeposit, CAIRN_DEFAULTS.autoDeposit),
    fragileWrites: toPositiveInt(source.fragileWrites, CAIRN_DEFAULTS.fragileWrites, 100),
    entryPointReads: toPositiveInt(source.entryPointReads, CAIRN_DEFAULTS.entryPointReads, 100)
  }
}

/* ------------------------------------------------------------------ *
 * Tool-call shape helpers
 *
 * The deferred-tool bridge wraps a real invocation as name `tool_call` with the
 * target inside `arguments = { name, arguments }`. Both shapes have to work or
 * the ledger silently records nothing under one preset.
 * ------------------------------------------------------------------ */

function effectiveNameOf(exec) {
  if (
    exec?.name === 'tool_call'
    && exec.arguments !== null && typeof exec.arguments === 'object'
    && typeof exec.arguments.name === 'string' && exec.arguments.name.length > 0
  ) {
    return exec.arguments.name
  }
  return typeof exec?.name === 'string' ? exec.name : ''
}

function effectiveArgumentsOf(exec) {
  if (
    exec?.name === 'tool_call'
    && exec.arguments !== null && typeof exec.arguments === 'object'
    && exec.arguments.arguments !== undefined
  ) {
    return exec.arguments.arguments
  }
  return exec?.arguments
}

const SHELL_TOOLS = new Set(['pwsh', 'bash', 'shell', 'run_shell'])

/** Pull the command string out of a shell call's arguments. */
function commandOf(args) {
  if (typeof args === 'string') return args
  if (args === null || typeof args !== 'object') return undefined
  return firstString(args.command, args.cmd, args.script, args.input)
}

/** Exit code from a finished shell result. The marker is the tool's own format. */
export function exitCodeOf(result) {
  const direct = Number(result?.value?.exitCode ?? result?.value?.exit_code)
  if (Number.isFinite(direct)) return direct
  const blocks = Array.isArray(result?.content) ? result.content : []
  for (const block of blocks) {
    if (block?.type !== 'text' || typeof block.text !== 'string') continue
    const match = /\[exit code: (\d+)\]/.exec(block.text)
    if (match !== null) return Number(match[1])
  }
  if (result?.isError === true) return 1
  return undefined
}

/**
 * The project root. Session cwd is the honest source; the harness stores it on
 * the session header, and `process.cwd()` would point at whatever the host was
 * launched from.
 */
export function rootOf(agent) {
  const candidates = [
    agent?.session?.header?.cwd,
    agent?.session?.cwd,
    agent?.cwd,
    agent?.session?.header?.workingDirectory
  ]
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.length > 0) return resolve(candidate)
  }
  return process.cwd()
}

/** Where pheromones live. Per project, under the DSH home. */
export function pheromonePathFor(root, home = process.env.DSH_HOME) {
  const base = firstString(home, join(homedir(), '.dsh'))
  return join(base, 'storages', 'dsh-cairn', `signals-${hashShort(root, 12)}.json`)
}

/* ------------------------------------------------------------------ *
 * Per-agent state
 * ------------------------------------------------------------------ */

/** Stand-in key for calls with no agent (a direct `ctx.tools.execute()`), so repeated ones share state. */
const SYNTHETIC_AGENT = Object.freeze({ synthetic: true })

function createAgentState(config, logger) {
  let ledger
  let store
  let boundRoot
  let lastReminder = ''
  let injections = 0
  /** Evidence keys already turned into a pheromone deposit. See `depositFromEvidence`. */
  const deposited = new Set()

  function ensure(agent) {
    if (ledger !== undefined && boundRoot !== undefined) return
    boundRoot = rootOf(agent)
    ledger = createLedger({ root: boundRoot })
    if (config.pheromoneEnabled) {
      store = createPheromoneStore({
        filePath: config.pheromonePersist ? pheromonePathFor(boundRoot) : undefined
      })
    }
    logger.debug?.(`dsh-cairn: tracking ${boundRoot}`)
  }

  return {
    ensure,
    get root() {
      return boundRoot
    },
    get ledger() {
      return ledger
    },
    get store() {
      return store
    },
    get deposited() {
      return deposited
    },
    get lastReminder() {
      return lastReminder
    },
    /**
     * Record the reminder just injected and return its sequence number. The
     * sequence, not the digest, forms the message id: the same evidence may
     * legitimately be delivered twice in one session (a new user prompt
     * reopens the turn), and a repeated id would collide in history.
     */
    rememberReminder(text) {
      lastReminder = text
      injections += 1
      return injections
    },
    /** A new user prompt means the model deserves the notice again. */
    forgetReminder() {
      lastReminder = ''
    },
    dispose() {
      try {
        store?.dispose()
      } catch {}
    }
  }
}

/* ------------------------------------------------------------------ *
 * Ledger feeding
 * ------------------------------------------------------------------ */

/**
 * Map a finished shell result to a ledger status.
 *
 * The harness marks success by omission: a non-zero exit is reported in the
 * result text as `[exit code: N]`, and a run that never completed sets
 * `isError`. So "no marker and no error" means the command exited 0 — it does
 * not mean the outcome was unknown. Anything else would force the ledger to
 * call every successful check "blocked" and make the gate useless.
 */
function verificationStatusOf(result, exitCode) {
  if (result?.isError === true) return 'failed'
  if (exitCode === undefined) return 'passed'
  return exitCode === 0 ? 'passed' : 'failed'
}

function classifyVerification(exec, result, verifyConfig, ownedFiles = []) {
  const toolName = effectiveNameOf(exec)
  if (!SHELL_TOOLS.has(toolName)) return undefined
  const command = commandOf(effectiveArgumentsOf(exec))
  if (command === undefined) return undefined
  const kind = classifyCommand(command, verifyConfig)
  const route = kind === undefined ? classifyRouteCommand(command, verifyConfig) : undefined
  if (kind === undefined && route === undefined) return undefined
  const exitCode = exitCodeOf(result)

  /**
   * A declared kind (`cargo test`) is a project-wide check, so it covers every
   * file the session touched. A route (`src/mm/**` -> `make test-shell`) is
   * not: running it says nothing about a changed `docs/` file. Covering the
   * changed files the route's globs actually name keeps a passing subsystem
   * check from laundering an untouched area into "verified".
   *
   * When no changed file falls under any route sharing this command, the run is
   * evidence about nothing in play and is not recorded — a verification with no
   * files would otherwise read as global coverage and claim the whole session.
   */
  let files
  if (route !== undefined) {
    const globs = (verifyConfig?.routes ?? []).filter((entry) => commandSatisfies(entry.run, command))
    files = ownedFiles.filter((file) => globs.some((entry) => isGlobMatch(entry.match, file)))
    if (files.length === 0) return undefined
  }

  return {
    command: command.trim(),
    kind: kind ?? route?.kind,
    status: verificationStatusOf(result, exitCode),
    exitCode,
    files
  }
}

function isDeliveryClaim(exec, args, state, config, verifyConfig) {
  if (config.gateMode !== 'deny') return undefined
  const toolName = effectiveNameOf(exec)
  for (const pattern of config.gateTools) {
    if (toolName === pattern || isGlobMatch(pattern, toolName)) return `tool "${toolName}"`
  }
  if (!SHELL_TOOLS.has(toolName)) return undefined
  const command = commandOf(args)
  if (command === undefined) return undefined
  const trimmed = command.trim()
  for (const pattern of config.gateCommands) {
    if (trimmed === pattern || trimmed.startsWith(`${pattern} `)) return `command "${pattern}"`
  }
  return undefined
}

/* ------------------------------------------------------------------ *
 * Pheromone deposits from evidence
 * ------------------------------------------------------------------ */

function depositFromEvidence(state, ledger, config) {
  const store = state.store
  if (store === undefined || !config.autoDeposit) return
  const attribution = ledger.attribute()

  /**
   * Evidence is a *count*, and a deposit is additive, so re-running this on
   * every tool call would inflate one signal without bound (`0.5 + 0.5 + …`).
   * Each deposit therefore carries a key derived from the evidence that
   * justified it: new evidence next step deposits again, the same evidence does
   * not deposit twice.
   */
  const depositable = (key) => {
    if (state.deposited.has(key)) return false
    state.deposited.add(key)
    return true
  }

  for (const entry of attribution) {
    if (entry.status === 'failed') {
      if (!depositable(`failed:${entry.path}:${entry.verifiedAt ?? 0}`)) continue
      store.deposit({
        path: entry.path,
        signal: 'fragile',
        strength: 0.8,
        context: `${entry.command ?? 'a declared check'} failed after this file was last written`
      })
    } else if (entry.status === 'passed') {
      if (!depositable(`passed:${entry.path}:${entry.verifiedAt ?? 0}`)) continue
      // Only reinforce when the check actually covered this file; a global
      // build passing says little about one source file, so the deposit is
      // weaker but still recorded.
      store.deposit({
        path: entry.path,
        signal: 'well-tested',
        strength: ledger.verifications().some((v) => (v.files ?? []).includes(entry.path)) ? 0.8 : 0.4,
        context: `verified by ${entry.command ?? 'a declared check'}`
      })
    }
  }

  const writesBy = new Map()
  for (const event of ledger.getEvents()) {
    if (event.type !== 'write' || event.path === undefined) continue
    writesBy.set(event.path, (writesBy.get(event.path) ?? 0) + 1)
  }
  for (const [path, count] of writesBy) {
    if (count < config.fragileWrites) continue
    const alreadyVerified = attribution.find((a) => a.path === path)?.status === 'passed'
    if (alreadyVerified) continue
    if (!depositable(`writes:${path}:${count}`)) continue
    store.deposit({
      path,
      signal: 'fragile',
      strength: 0.5,
      context: `edited ${count} times in one session without a passing verification`
    })
  }

  const readsBy = new Map()
  for (const event of ledger.getEvents()) {
    if (event.type !== 'read' || event.path === undefined) continue
    readsBy.set(event.path, (readsBy.get(event.path) ?? 0) + 1)
  }
  for (const [path, count] of readsBy) {
    if (count < config.entryPointReads) continue
    if (!depositable(`reads:${path}:${count}`)) continue
    store.deposit({
      path,
      signal: 'entry-point',
      strength: 0.35,
      context: `read ${count} times in one session`
    })
  }
}

/* ------------------------------------------------------------------ *
 * Plugin entry
 * ------------------------------------------------------------------ */

export async function apply(ctx, rawConfig = {}) {
  const config = normalizeConfig(rawConfig)
  const logger = ctx.logger
  if (!config.enabled) {
    logger.warn('dsh-cairn: disabled by config')
    return
  }

  const states = new WeakMap()
  /** Disposal needs an iterable; a WeakMap has none. */
  const live = []

  function stateFor(agent) {
    const key = agent ?? SYNTHETIC_AGENT
    let state = states.get(key)
    if (state === undefined) {
      state = createAgentState(config, logger)
      states.set(key, state)
      live.push(state)
    }
    state.ensure(agent)
    return state
  }

  function verifyFor(state) {
    if (!config.verify || state.root === undefined) return { ok: true, config: { routes: [] } }
    return loadVerifyConfig(state.root)
  }

  /** Everything the reminder needs, computed fresh. */
  function snapshot(agent) {
    const state = stateFor(agent)
    const ledger = state.ledger
    const loaded = verifyFor(state)
    const verifyConfig = loaded.config
    const readiness = ledger.readiness()
    const changed = readiness.files.map((file) => file.path)
    const routes = matchRoutes(changed, verifyConfig.routes, { root: state.root })
    return { state, readiness, routes, verifyConfig, verifyOk: loaded.ok, reason: loaded.reason }
  }

  /* ------------------------------------------------------------------ *
   * Evidence intake: filesystem.
   *
   * `fs/observed` is the only honest seam. It fires from the tool that
   * actually touched the file, after the touch succeeded, and it carries the
   * actor — so a read is `actor.name === 'read'` and a mutation is
   * `'write'`/`'edit'` (`mutationToolName` in the shipped skill provider uses
   * exactly this test). `fs/write-intent` fires *before* the write and also
   * for writes a policy then denies, which would put phantom files in the
   * ledger, so it is deliberately not used here.
   * ------------------------------------------------------------------ */

  const MUTATION_TOOL_NAMES = new Set(['write', 'edit'])
  const READ_TOOL_NAMES = new Set(['read'])

  function absoluteFor(state, target) {
    const display = firstString(target?.displayPath, target?.path)
    if (display === undefined) return undefined
    return isAbsolute(display) ? display : resolve(state.root ?? process.cwd(), display)
  }

  ctx.on('fs/observed', (target, observation, actor) => {
    try {
      if (observation?.kind !== 'present') return
      const toolName = effectiveNameOf(actor)
      const state = stateFor(actor?.agent)
      const abs = absoluteFor(state, target)
      if (abs === undefined) return
      if (MUTATION_TOOL_NAMES.has(toolName)) {
        // A path the project declares as scratch is not part of what this
        // session changed, so it never enters the readiness list. Measured on a
        // real session: without this, 121 of 163 notices named a throwaway
        // script under `.rivet/` and pushed the source actually under change off
        // a list that only shows six files.
        if (isIgnored(toRootRelative(state.root, abs), verifyFor(state).config)) return
        state.ledger.recordWrite(abs, { tool: toolName })
        return
      }
      if (READ_TOOL_NAMES.has(toolName)) state.ledger.recordRead(abs, { tool: toolName })
    } catch (error) {
      logger.debug?.(`dsh-cairn: could not record a filesystem observation: ${String(error)}`)
    }
  })

  /* ------------------------------------------------------------------ *
   * The reminder.
   *
   * Delivery rides `additionalContexts` on a `tools/post-execute` decision,
   * exactly as the shipped `repeat-tool-reminder` guard does. The loop accepts
   * each context into the next step's inbox and appends it as an injected
   * `user/message` after the step's tool results, so it replays, compacts and
   * resumes like any other message — and, unlike appending to the messages of
   * an `agent/pre-step` decision, it still passes through the runtime-context
   * projection that stamps a timestamp on history (the `Current runtime
   * context` block a resumed session receives).
   *
   * `source.kind` is a plain label here, not a registered source: the harness
   * only requires it to be present, which is what keeps the message from
   * rendering as a raw user prompt in derived history.
   * ------------------------------------------------------------------ */

  function summariseReadiness(readiness) {
    const files = Array.isArray(readiness?.files) ? readiness.files : []
    const unverified = files.filter((file) => file.status === 'unverified').length
    const failed = files.filter((file) => file.status === 'failed').length
    const parts = [`${files.length} changed`]
    if (failed > 0) parts.push(`${failed} failed`)
    if (unverified > 0) parts.push(`${unverified} unverified`)
    return parts.join(' · ')
  }

  /** The notice for this moment, or `undefined` when there is nothing to say. */
  function reminderFor(agent) {
    if (!config.injectReadiness || config.gateMode === 'off') return undefined
    const state = stateFor(agent)
    const { readiness, routes } = snapshot(agent)
    const readinessBlock = buildReadinessReminder(readiness, routes, {})
    if (readinessBlock === '') return undefined

    const pheromones = config.pheromoneEnabled && state.store !== undefined
      ? state.store.forPaths(readiness.files.map((file) => file.path), { minStrength: 0.2, limit: 3 })
      : []
    const text = buildStepReminder({ readiness, routes, pheromones }, { maxSignals: 3 })
    if (text === '') return undefined

    // Same evidence, same words: inject once. Repeating an unchanged reminder
    // every step trains the model to skim and bills for every repetition.
    const digest = hashShort(text, 16)
    if (state.lastReminder === digest) return undefined
    const sequence = state.rememberReminder(digest)

    return {
      id: stableId('cairn-reminder', String(agent?.id ?? 'agent'), String(sequence)),
      role: 'user',
      content: [{ type: 'text', text }],
      source: {
        kind: 'cairn',
        form: 'notice',
        summary: summariseReadiness(readiness).slice(0, 120)
      }
    }
  }

  /* ---- evidence intake: shell commands that satisfy a declared check ---- */

  ctx.on('tools/post-execute', async (exec, result, next) => {
    const decision = await next()
    try {
      const state = stateFor(exec?.agent)
      const loaded = verifyFor(state)
      const verification = classifyVerification(exec, result, loaded.config, state.ledger.ownedFiles())
      if (verification !== undefined) {
        state.ledger.recordVerification({
          command: verification.command,
          kind: verification.kind,
          status: verification.status,
          exitCode: verification.exitCode,
          files: verification.files
        })
      }
      // Not `else`: a project that declares no check still learns which paths it
      // edits and re-reads, and gating this on a verification meant those
      // signals were never deposited in exactly the projects that need them.
      depositFromEvidence(state, state.ledger, config)
    } catch (error) {
      logger.debug?.(`dsh-cairn: verification intake failed: ${String(error)}`)
    }

    let reminder
    try {
      reminder = reminderFor(exec?.agent)
    } catch (error) {
      logger.debug?.(`dsh-cairn: reminder failed: ${String(error)}`)
    }
    if (reminder === undefined) return decision
    const downstream = Array.isArray(decision?.additionalContexts) ? decision.additionalContexts : []
    return { ...decision, additionalContexts: [reminder, ...downstream] }
  })

  /* ---- the gate: hold a delivery claim when the ledger says unverified ---- */

  ctx.on('tools/pre-execute', (exec, next) => {
    try {
      if (config.gateMode !== 'deny') return next()
      const state = stateFor(exec?.agent)
      const claim = isDeliveryClaim(exec, effectiveArgumentsOf(exec), state, config, verifyFor(state).config)
      if (claim === undefined) return next()
      const readiness = state.ledger.readiness()
      if (readiness.canDeliver && readiness.level === 'verified') return next()
      return {
        kind: 'deny',
        reason:
          `dsh-cairn: ${claim} is a delivery claim, but ${readiness.level}. ${readiness.reason}. `
          + 'Run the declared check (or record why it cannot run) before delivering.'
      }
    } catch {
      return next()
    }
  })

  /* ---- a real user prompt opens a new turn: allow the same notice again ---- */

  ctx.on('agent/pre-step', ({ agent, messages }, next) => {
    try {
      const prompted = Array.isArray(messages) && messages.some((message) => message?.source?.kind === 'user')
      if (prompted) states.get(agent)?.forgetReminder()
    } catch {}
    return next()
  })

  /* ---- persist pheromones before the process goes away ---- */

  ctx.effect(() => () => {
    for (const state of live) {
      try {
        state.dispose()
      } catch {}
    }
  }, 'dsh-cairn persistence')

  /* ---- tools ---- */

  ctx.tools.register(defineTool({
    name: 'cairn_status',
    description:
      'Report what this session changed, which of those files have been verified after their last write, '
      + 'and what the project declares as its checks. Use it before claiming work is complete, or when '
      + 'you need to know whether an earlier edit is still covered by a passing check.',
    parameters: {
      verbose: {
        type: 'boolean',
        description: 'Include every verification event and every tracked file instead of the summary.'
      }
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          level: { type: 'string' },
          canDeliver: { type: 'boolean' },
          reason: { type: 'string' },
          files: { type: 'array', items: { type: 'object' } },
          verifications: { type: 'array', items: { type: 'object' } },
          declared: { type: 'string' },
          routes: { type: 'array', items: { type: 'object' } },
          signals: { type: 'array', items: { type: 'object' } },
          root: { type: 'string' }
        }
      },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }]
    },
    async execute(args, exec) {
      const { state, readiness, routes, verifyConfig, verifyOk, reason } = snapshot(exec?.agent)
      const verbose = args?.verbose === true
      const verifications = state.ledger.verifications()
      const signals = state.store === undefined
        ? []
        : state.store.forPaths(readiness.files.map((file) => file.path), { minStrength: 0.05, limit: 20 })
      return {
        level: readiness.level,
        canDeliver: readiness.canDeliver,
        reason: readiness.reason,
        files: verbose ? readiness.files : readiness.files.slice(0, 20),
        verifications: (verbose ? verifications : verifications.slice(-5)).map((event) => ({
          command: event.command,
          kind: event.kind,
          status: event.status,
          at: event.at
        })),
        declared: verifyOk
          ? describeVerifyConfig(verifyConfig)
          : `unreadable: ${reason ?? 'unknown reason'}`,
        routes,
        signals: signals.map((entry) => ({
          path: entry.path,
          signal: entry.signal,
          strength: Number(entry.current.toFixed(3)),
          context: entry.context
        })),
        root: state.root ?? ''
      }
    }
  }))

  ctx.tools.register(defineTool({
    name: 'cairn_routes',
    description:
      'Show the checks the project declares for specific files or globs (from .cairn/verify.json). '
      + 'This only reports commands; it never runs them. Run the command yourself and the ledger will '
      + 'attribute the result to the files.',
    parameters: {
      files: {
        type: 'array',
        items: { type: 'string' },
        description: 'Repo-relative paths to match. Omit to use the files this session changed.'
      }
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          root: { type: 'string' },
          declared: { type: 'string' },
          hint: { type: 'string' },
          matched: { type: 'array', items: { type: 'object' } },
          error: { type: 'string' }
        }
      },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }]
    },
    async execute(args, exec) {
      const state = stateFor(exec?.agent)
      const loaded = verifyFor(state)
      if (!loaded.ok) {
        return { root: state.root ?? '', declared: 'unreadable', hint: '', matched: [], error: loaded.reason }
      }
      const files = Array.isArray(args?.files) && args.files.length > 0
        ? args.files
        : state.ledger.ownedFiles()
      const matched = matchRoutes(files, loaded.config.routes, { root: state.root })
      return {
        root: state.root ?? '',
        declared: describeVerifyConfig(loaded.config),
        hint: renderVerifyHint(loaded.config),
        matched,
        error: ''
      }
    }
  }))

  ctx.tools.register(defineTool({
    name: 'cairn_signal',
    description:
      'Leave or read a decaying marker on a path. Signals survive into later sessions and carry a short '
      + 'reason, so a future agent inherits "this file is fragile" without inheriting a transcript. '
      + 'Deposit one when a check fails (fragile), when something turns out to be well covered '
      + '(well-tested), when a path is expensive to change (performance-critical), when a refactor is '
      + 'obviously needed (refactor-candidate), when a line of approach is abandoned (dead-end), when a '
      + 'path is the way into a subsystem (entry-point), or when many things depend on it (coupling-hub).',
    parameters: {
      action: {
        type: 'string',
        enum: ['deposit', 'list', 'forget'],
        description: 'What to do. Defaults to `list`.'
      },
      path: { type: 'string', description: 'Repo-relative path the signal is about.' },
      signal: {
        type: 'string',
        enum: [...PHEROMONE_SIGNALS],
        description: 'Which signal. Required for `deposit` and `forget`.'
      },
      strength: { type: 'number', description: 'Deposit strength 0..1. Defaults to 0.5.' },
      context: { type: 'string', description: 'One short line explaining the signal. Bounded to 280 chars.' }
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          action: { type: 'string' },
          changed: { type: 'number' },
          entries: { type: 'array', items: { type: 'object' } },
          error: { type: 'string' }
        }
      },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }]
    },
    async execute(args, exec) {
      const state = stateFor(exec?.agent)
      const store = state.store
      if (store === undefined) {
        return { action: String(args?.action ?? 'list'), changed: 0, entries: [], error: 'pheromones are disabled' }
      }
      const action = firstString(args?.action, 'list')
      const path = typeof args?.path === 'string' ? args.path : undefined
      const signal = typeof args?.signal === 'string' ? args.signal : undefined

      if (action === 'deposit') {
        if (path === undefined || signal === undefined) {
          return { action, changed: 0, entries: [], error: 'deposit needs `path` and `signal`' }
        }
        const relative = toRootRelative(state.root, resolve(state.root ?? process.cwd(), path)) ?? path
        const entry = store.deposit({
          path: relative,
          signal,
          strength: typeof args?.strength === 'number' ? args.strength : 0.5,
          context: typeof args?.context === 'string' ? args.context : undefined,
          sessionId: exec?.agent?.id
        })
        if (entry === undefined) return { action, changed: 0, entries: [], error: 'deposit rejected' }
        store.flush()
        return {
          action,
          changed: 1,
          entries: [{ path: entry.path, signal: entry.signal, halfLifeMs: entry.halfLife, strength: entry.strength }],
          error: ''
        }
      }

      if (action === 'forget') {
        if (path === undefined) return { action, changed: 0, entries: [], error: 'forget needs `path`' }
        const relative = toRootRelative(state.root, resolve(state.root ?? process.cwd(), path)) ?? path
        const changed = store.forget(relative, signal)
        store.flush()
        return { action, changed, entries: [], error: '' }
      }

      const entries = store.query({ pathPrefix: path, limit: 40 }).map((entry) => ({
        path: entry.path,
        signal: entry.signal,
        strength: Number(entry.current.toFixed(3)),
        halfLifeMs: entry.halfLife,
        context: entry.context
      }))
      return { action: 'list', changed: 0, entries, error: '' }
    }
  }))

  logger.warn(
    'dsh-cairn: active'
      + ` · routes ${config.verify ? `from ${VERIFY_CONFIG_PATH} when present` : 'disabled'}`
      + ` · gate ${config.gateMode}`
      + ` · pheromones ${config.pheromoneEnabled ? (config.pheromonePersist ? 'on (persisted)' : 'on (memory only)') : 'off'}`
      + ' · this plugin spends tokens by design; it saves none'
  )
  logger.debug?.(
    `dsh-cairn: kinds ${VERIFY_KINDS.join(',')}`
      + ` · half-lives ${Object.keys(PHEROMONE_HALF_LIVES).length}`
      + ` · ancestor lookup ${typeof findAncestorWith === 'function' ? 'available' : 'missing'}`
  )
}

export { createLedger } from './ledger.js'
export { createPheromoneStore } from './pheromone.js'
export * from './core.js'
export * from './verify.js'
export * from './remind.js'
