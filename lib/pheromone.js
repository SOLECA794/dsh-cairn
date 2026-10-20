/**
 * Pheromones — file-level memory that outlives a session.
 *
 * Every other kind of context in the harness is a function of the current
 * conversation: history, summaries, compaction checkpoints. That means the one
 * thing a long project knows most reliably — *this file has broken three times*,
 * *this syscall path was a dead end* — is exactly the thing that evaporates when
 * the window is compressed. A pheromone is a small, decaying note attached to a
 * path so the next session reads the terrain, not just the transcript.
 *
 * Three properties matter, and each one is a decision:
 *
 * 1. **Decay, not deletion.** Strength halves every half-life. A one-off
 *    "fragile" that was never re-observed fades to nothing on its own, so the
 *    store cannot accumulate superstition; a signal re-deposited every session
 *    stays near 1. No manual garbage collection is required for the common case.
 * 2. **Reinforcement, not replacement.** Depositing the same signal on the same
 *    path adds strength and restarts the clock, capped at 1. That is what makes
 *    the ranking meaningful: the top of the list is what keeps happening.
 * 3. **Cheap to ignore.** A signal is a sentence, not a document. If reading the
 *    pheromones costs more than the mistake they prevent, they are noise, so
 *    every rendered line is bounded and the store has a hard capacity.
 */

import { readJsonSafe, writeJsonAtomic } from './core.js'

/** Signals worth recording. Anything else is dropped at deposit time. */
export const PHEROMONE_SIGNALS = Object.freeze([
  'fragile',
  'well-tested',
  'performance-critical',
  'refactor-candidate',
  'dead-end',
  'entry-point',
  'coupling-hub'
])

const DAY = 86_400_000

/**
 * Half-life per signal. A "dead-end" is a fact about an approach and ages out
 * fast — the code it described is usually rewritten. "performance-critical" is
 * a property of the subsystem and survives a quarter.
 */
export const PHEROMONE_HALF_LIVES = Object.freeze({
  fragile: 7 * DAY,
  'well-tested': 14 * DAY,
  'performance-critical': 30 * DAY,
  'refactor-candidate': 14 * DAY,
  'dead-end': 7 * DAY,
  'entry-point': 30 * DAY,
  'coupling-hub': 21 * DAY
})

export const PHEROMONE_DEFAULTS = Object.freeze({
  /** Hard cap; over capacity the weakest entries are evicted. */
  capacity: 200,
  /** Below this current strength an entry is pruned on the next sweep. */
  pruneBelow: 0.05,
  /** Coalesce bursts of deposits into one write. */
  debounceMs: 200,
  /** A context string is a reminder, not a note-taking app. */
  maxContextChars: 280
})

/** Current strength after exponential decay. */
export function decayedStrength(entry, at = Date.now()) {
  if (entry === null || typeof entry !== 'object') return 0
  const strength = Number(entry.strength)
  if (!Number.isFinite(strength) || strength <= 0) return 0
  const halfLife = Number(entry.halfLife)
  if (!Number.isFinite(halfLife) || halfLife <= 0) return strength
  const age = Math.max(0, at - Number(entry.depositedAt ?? 0))
  return strength * Math.pow(0.5, age / halfLife)
}

/** Clamp, keeping the API honest about what a "strength" is. */
function clampStrength(value) {
  const n = Number(value)
  if (!Number.isFinite(n)) return 0.5
  return Math.min(1, Math.max(0, n))
}

function entryKey(path, signal) {
  return `${path}\u0000${signal}`
}

function sanitizeEntry(raw) {
  if (raw === null || typeof raw !== 'object') return undefined
  if (typeof raw.path !== 'string' || raw.path.length === 0) return undefined
  if (!PHEROMONE_SIGNALS.includes(raw.signal)) return undefined
  const depositedAt = Number(raw.depositedAt)
  if (!Number.isFinite(depositedAt)) return undefined
  const halfLife = Number(raw.halfLife)
  const entry = {
    path: raw.path,
    signal: raw.signal,
    strength: clampStrength(raw.strength),
    depositedAt,
    halfLife: Number.isFinite(halfLife) && halfLife > 0 ? halfLife : PHEROMONE_HALF_LIVES[raw.signal]
  }
  if (typeof raw.context === 'string' && raw.context.length > 0) {
    entry.context = raw.context.slice(0, PHEROMONE_DEFAULTS.maxContextChars)
  }
  if (typeof raw.sessionId === 'string' && raw.sessionId.length > 0) entry.sessionId = raw.sessionId
  return entry
}

/**
 * Create a store. Without `filePath` it is memory-only (tests, or a user who
 * turned persistence off).
 */
export function createPheromoneStore(options = {}) {
  const defaults = { ...PHEROMONE_DEFAULTS, ...(options.defaults ?? {}) }
  const filePath = options.filePath
  const now = typeof options.now === 'function' ? options.now : () => Date.now()
  const debounceMs = Math.max(0, Number(defaults.debounceMs) || 0)

  /** @type {Map<string, object>} */
  let entries = new Map()
  let dirty = false
  let timer
  let disposed = false
  let lastWriteOk = true
  let writeCount = 0

  function load() {
    if (filePath === undefined) return
    const raw = readJsonSafe(filePath)
    const list = Array.isArray(raw?.entries) ? raw.entries : []
    entries = new Map()
    for (const item of list) {
      const entry = sanitizeEntry(item)
      if (entry === undefined) continue
      entries.set(entryKey(entry.path, entry.signal), entry)
    }
    prune({ persist: false })
    dirty = false
  }

  function scheduleFlush() {
    if (filePath === undefined) return
    dirty = true
    if (disposed) return
    if (timer !== undefined) return
    timer = setTimeout(() => {
      timer = undefined
      flush()
    }, debounceMs)
    // A pending write must not hold the process open.
    if (typeof timer.unref === 'function') timer.unref()
  }

  /**
   * Persist now. The dirty flag is cleared **only after** a successful write —
   * clearing first is how a storage failure silently loses the signals someone
   * thought they had saved.
   */
  function flush() {
    if (filePath === undefined) {
      dirty = false
      return true
    }
    if (!dirty) return true
    const snapshot = {
      version: 1,
      savedAt: now(),
      entries: [...entries.values()]
    }
    const ok = writeJsonAtomic(filePath, snapshot)
    lastWriteOk = ok
    if (ok) {
      writeCount += 1
      dirty = false
    }
    return ok
  }

  /**
   * Add or reinforce a signal. Returns the stored entry, or undefined when the
   * input is rejected (unknown signal, empty path).
   */
  function deposit(input = {}) {
    if (input === null || typeof input !== 'object') return undefined
    if (!PHEROMONE_SIGNALS.includes(input.signal)) return undefined
    if (typeof input.path !== 'string' || input.path.length === 0) return undefined
    const at = Number.isFinite(input.at) ? Number(input.at) : now()
    const halfLife = Number.isFinite(input.halfLife) && Number(input.halfLife) > 0
      ? Number(input.halfLife)
      : PHEROMONE_HALF_LIVES[input.signal]
    const key = entryKey(input.path, input.signal)
    const existing = entries.get(key)
    const current = existing === undefined ? 0 : decayedStrength(existing, at)
    const added = clampStrength(input.strength ?? 0.5)
    // Reinforce additively so a repeatedly-observed signal climbs toward 1
    // instead of being pinned by whichever deposit happened to be strongest.
    const entry = {
      path: input.path,
      signal: input.signal,
      strength: Math.min(1, current + added),
      depositedAt: at,
      halfLife
    }
    const context = typeof input.context === 'string' ? input.context.trim() : ''
    if (context.length > 0) entry.context = context.slice(0, defaults.maxContextChars)
    if (typeof input.sessionId === 'string' && input.sessionId.length > 0) {
      entry.sessionId = input.sessionId
    }
    entries.set(key, entry)
    enforceCapacity()
    scheduleFlush()
    return entry
  }

  function enforceCapacity() {
    const cap = Math.max(1, Number(defaults.capacity) || PHEROMONE_DEFAULTS.capacity)
    if (entries.size <= cap) return
    const at = now()
    const ranked = [...entries.entries()]
      .map(([key, entry]) => ({ key, strength: decayedStrength(entry, at) }))
      .sort((a, b) => b.strength - a.strength)
    for (const { key } of ranked.slice(cap)) entries.delete(key)
  }

  /** Drop entries that have decayed below the threshold. */
  function prune({ persist = true } = {}) {
    const at = now()
    const threshold = Number(defaults.pruneBelow) || 0
    let removed = 0
    for (const [key, entry] of [...entries.entries()]) {
      if (decayedStrength(entry, at) < threshold) {
        entries.delete(key)
        removed += 1
      }
    }
    if (removed > 0 && persist) scheduleFlush()
    return removed
  }

  /**
   * Query by signal and/or path prefix. Results carry `current` strength so a
   * caller never has to remember to apply decay itself.
   */
  function query({ signal, pathPrefix, minStrength = 0, limit = 50, at } = {}) {
    const stamp = Number.isFinite(at) ? Number(at) : now()
    const out = []
    for (const entry of entries.values()) {
      if (signal !== undefined && entry.signal !== signal) continue
      if (pathPrefix !== undefined && !entry.path.startsWith(pathPrefix)) continue
      const current = decayedStrength(entry, stamp)
      if (current < minStrength) continue
      out.push({ ...entry, current })
    }
    out.sort((a, b) => b.current - a.current || a.path.localeCompare(b.path))
    return out.slice(0, Math.max(1, Number(limit) || 50))
  }

  /** Entries restricted to a set of paths (the gate's "about my changes" view). */
  function forPaths(paths, options = {}) {
    if (!Array.isArray(paths) || paths.length === 0) return []
    const set = new Set(paths)
    const at = Number.isFinite(options.at) ? Number(options.at) : now()
    const out = []
    for (const entry of entries.values()) {
      if (!set.has(entry.path)) continue
      const current = decayedStrength(entry, at)
      if (current < (options.minStrength ?? 0)) continue
      out.push({ ...entry, current })
    }
    out.sort((a, b) => b.current - a.current)
    return out.slice(0, Math.max(1, Number(options.limit) || 20))
  }

  function forget(path, signal) {
    if (signal === undefined) {
      let removed = 0
      for (const [key, entry] of [...entries.entries()]) {
        if (entry.path === path) {
          entries.delete(key)
          removed += 1
        }
      }
      if (removed > 0) scheduleFlush()
      return removed
    }
    const key = entryKey(path, signal)
    const had = entries.delete(key)
    if (had) scheduleFlush()
    return had ? 1 : 0
  }

  function summary(at) {
    const stamp = Number.isFinite(at) ? Number(at) : now()
    const live = [...entries.values()].map((entry) => decayedStrength(entry, stamp))
    const bySignal = {}
    for (const entry of entries.values()) {
      bySignal[entry.signal] = (bySignal[entry.signal] ?? 0) + 1
    }
    return {
      entryCount: entries.size,
      totalStrength: live.reduce((sum, value) => sum + value, 0),
      bySignal,
      dirty,
      persisted: filePath !== undefined,
      filePath,
      lastWriteOk,
      writeCount
    }
  }

  function reset() {
    entries = new Map()
    dirty = false
    if (filePath !== undefined) writeJsonAtomic(filePath, { version: 1, savedAt: now(), entries: [] })
  }

  function dispose() {
    if (timer !== undefined) {
      clearTimeout(timer)
      timer = undefined
    }
    flush()
    disposed = true
  }

  if (options.autoLoad !== false) load()

  return {
    load,
    deposit,
    query,
    forPaths,
    prune,
    forget,
    flush,
    summary,
    reset,
    dispose,
    get size() {
      return entries.size
    }
  }
}
