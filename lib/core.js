/**
 * Shared primitives. Pure functions and a few filesystem helpers — no harness
 * imports, so every module below can be unit-tested without a DSH install.
 */

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'

/** Stable short digest, used for ids and store keys. */
export function hashShort(input, length = 16) {
  return createHash('sha256').update(String(input)).digest('hex').slice(0, length)
}

/** Build a deterministic id from parts. Deterministic ids let callers dedupe. */
export function stableId(prefix, ...parts) {
  return `${prefix}:${hashShort(parts.join('\u0000'), 16)}`
}

/** Windows separators to POSIX, so glob matching is one code path. */
export function toPosix(p) {
  return String(p).split(sep).join('/').split('\\').join('/')
}

/** Absolute on either platform, judged without touching the host's cwd. */
export function isAbsolutePath(p) {
  if (typeof p !== 'string' || p.length === 0) return false
  if (p.startsWith('/') || p.startsWith('\\\\')) return true
  return /^[A-Za-z]:[\\/]/.test(p)
}

/** Repo-relative POSIX path, or null when the path escapes the root. */
export function toRootRelative(root, p) {
  if (typeof root !== 'string' || root.length === 0) return null
  if (typeof p !== 'string' || p.length === 0) return null
  const rel = relative(resolve(root), resolve(p))
  if (rel.length === 0) return null
  if (rel.startsWith('..') || isAbsolutePath(rel)) return null
  return toPosix(rel)
}

/**
 * Convert a route glob to a RegExp anchored on the full POSIX path.
 *
 * Semantics (minimatch-compatible, deliberately dependency-free — this file is
 * on the hot path of every tool result, and a glob library is not worth a
 * supply-chain edge for four constructs):
 *   `**` spans segments; `**` immediately before `/` also matches zero
 *   segments (`**\/*.rs` hits a file at the root too); `*` stays inside one
 *   segment; `?` matches exactly one non-separator character.
 *
 * A malformed glob throws; callers decide whether to skip or fail.
 */
export function globToRegExp(glob) {
  if (typeof glob !== 'string' || glob.length === 0) {
    throw new TypeError('glob must be a non-empty string')
  }
  const source = glob
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*\//g, '\u0000DS\u0000')
    .replace(/\*\*/g, '\u0000D\u0000')
    .replace(/\*/g, '[^/]*')
    .replace(/\?/g, '[^/]')
    .replace(/\u0000DS\u0000/g, '(?:.*/)?')
    .replace(/\u0000D\u0000/g, '.*')
  return new RegExp(`^${source}$`, 'u')
}

/** Non-throwing glob test: a malformed pattern never matches. */
export function isGlobMatch(glob, path) {
  try {
    return globToRegExp(glob).test(toPosix(path))
  } catch {
    return false
  }
}

/**
 * Rough token estimate. CJK runs about one token per 1.2 characters; Latin text
 * about one per 4. Only used for human-facing reporting, never for billing.
 */
export function estimateTokens(text) {
  if (typeof text !== 'string' || text.length === 0) return 0
  let cjk = 0
  for (const ch of text) {
    const cp = ch.codePointAt(0)
    if (
      (cp >= 0x3400 && cp <= 0x4dbf) ||
      (cp >= 0x4e00 && cp <= 0x9fff) ||
      (cp >= 0x3040 && cp <= 0x30ff) ||
      (cp >= 0xac00 && cp <= 0xd7af) ||
      (cp >= 0x20000 && cp <= 0x2a6df)
    ) {
      cjk += 1
    }
  }
  return Math.ceil(cjk / 1.2) + Math.ceil((text.length - cjk) / 4)
}

/** Compact character count for reminders: 1234 -> "1.2K". */
export function formatCount(n) {
  const value = Number(n) || 0
  if (Math.abs(value) < 1000) return String(Math.round(value))
  if (Math.abs(value) < 1000000) return `${(value / 1000).toFixed(1)}K`
  return `${(value / 1000000).toFixed(1)}M`
}

/** Clamp an integer into a range, falling back to the floor for non-numbers. */
export function clampInt(value, lo, hi, fallback = lo) {
  const n = Number.isFinite(value) ? Math.trunc(Number(value)) : fallback
  return Math.min(hi, Math.max(lo, n))
}

/** Read JSON, returning undefined for anything unreadable. Never throws. */
export function readJsonSafe(file) {
  try {
    if (!existsSync(file)) return undefined
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return undefined
  }
}

/**
 * Write JSON via temp file + rename so a reader never sees a half-written
 * document. Returns true only when the rename landed.
 */
export function writeJsonAtomic(file, value, { indent = 0 } = {}) {
  try {
    mkdirSync(dirname(file), { recursive: true })
    const tmp = `${file}.${process.pid}.tmp`
    writeFileSync(tmp, JSON.stringify(value, null, indent), 'utf8')
    renameSync(tmp, file)
    return true
  } catch {
    return false
  }
}

/** Escape a body so it cannot terminate the wrapper tag early. */
export function escapeTagBody(text, tag) {
  return String(text).split(`</${tag}>`).join(`<\\/${tag}>`)
}

/**
 * Walk up from a directory looking for a marker file. Returns the containing
 * directory, or null. Bounded so a pathological tree cannot spin.
 */
export function findAncestorWith(startDir, markers, { maxDepth = 24 } = {}) {
  if (typeof startDir !== 'string' || startDir.length === 0) return null
  let dir = resolve(startDir)
  for (let depth = 0; depth <= maxDepth; depth += 1) {
    for (const marker of markers) {
      if (existsSync(resolve(dir, marker))) return dir
    }
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return null
}

/** ISO timestamp for ledgers and reminders. */
export function nowIso(at = Date.now()) {
  return new Date(at).toISOString()
}
