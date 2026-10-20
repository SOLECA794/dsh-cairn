/**
 * Task ledger — what this session actually changed, and what has actually been
 * checked since.
 *
 * The failure this exists to catch is not "the tests failed". It is *"I fixed
 * it"* followed by nobody running anything. A transcript is a record of
 * intentions; it cannot answer "is the working tree verified", because the
 * model's own summary of its work is not evidence. The ledger is: it records
 * writes and command outcomes as they happen, and computes readiness from
 * timestamps rather than from claims.
 *
 * ## Attribution, and why this is not just a global counter
 *
 * The obvious implementation counts writes and counts verifications and
 * compares the totals. That is wrong in both directions:
 *
 * - A check that ran *before* the last edit proves nothing about that edit.
 * - A check that ran *after* five of six edits proves something about five.
 *
 * So readiness is computed per owned file: a file is verified only when some
 * passing verification **covering that file** ran at or after that file's last
 * write. One `cargo check` after an hour of edits does verify all of them; the
 * same `cargo check` followed by one more edit leaves exactly that one file
 * unverified. A coverage ratio would report "83% verified" for a tree that is
 * simply not verified, and 83% ships.
 */

import { toPosix, toRootRelative } from './core.js'

/** Every event kind the ledger understands. */
export const LEDGER_EVENT_TYPES = Object.freeze([
  'write',
  'read',
  'verification',
  'git',
  'note'
])

/** Outcome of a command, as the ledger records it. */
export const VERIFICATION_STATUSES = Object.freeze(['passed', 'failed', 'blocked'])

/** Overall delivery state. `external_blocked` means "unverified, and not our fault". */
export const DELIVERY_LEVELS = Object.freeze([
  'verified',
  'failed',
  'blocked',
  'unverified',
  'external_blocked'
])

export const LEDGER_DEFAULTS = Object.freeze({
  /** Ring size; a marathon session should not hold an unbounded array. */
  maxEvents: 4000,
  /** Per-file cap on retained read events (used only for the pheromone count). */
  maxReadsPerFile: 50
})

/**
 * Create a ledger. `now` is injectable so attribution tests are deterministic.
 */
export function createLedger(options = {}) {
  const maxEvents = options.maxEvents ?? LEDGER_DEFAULTS.maxEvents
  const now = typeof options.now === 'function' ? options.now : () => Date.now()
  const root = options.root

  /** @type {Array<{type:string, at:number, seq?:number, path?:string, command?:string, kind?:string, status?:string, files?:string[], tool?:string, note?:string}>} */
  let events = []
  let dropped = 0
  /**
   * Monotonic sequence.
   *
   * `at` is wall-clock milliseconds, and a 1 ms granularity is too coarse to
   * order events that genuinely happen in sequence: write → check → write inside
   * one tick would make the check look as if it covered the second write, which
   * is the exact false pass this ledger exists to catch. Ordering therefore uses
   * `(at, seq)`; `at` stays human-readable for the report.
   */
  let seq = 0

  function relPath(p) {
    if (typeof p !== 'string' || p.length === 0) return undefined
    if (root === undefined) return toPosix(p)
    return toRootRelative(root, p) ?? toPosix(p)
  }

  function push(event) {
    seq += 1
    const entry = { ...event, at: event.at ?? now(), seq }
    if (entry.path !== undefined) entry.path = relPath(entry.path)
    if (Array.isArray(entry.files)) {
      entry.files = entry.files.map((f) => relPath(f)).filter((f) => typeof f === 'string')
    }
    events.push(entry)
    if (events.length > maxEvents) {
      const overflow = events.length - maxEvents
      events = events.slice(overflow)
      dropped += overflow
    }
    return entry
  }

  function record(event) {
    if (event === null || typeof event !== 'object') return undefined
    if (!LEDGER_EVENT_TYPES.includes(event.type)) return undefined
    return push(event)
  }

  /** A file was written or edited. This is what creates ownership. */
  function recordWrite(path, meta = {}) {
    return push({ type: 'write', path, tool: meta.tool, at: meta.at })
  }

  function recordRead(path, meta = {}) {
    const rel = relPath(path)
    if (rel === undefined) return undefined
    const count = events.filter((e) => e.type === 'read' && e.path === rel).length
    if (count >= LEDGER_DEFAULTS.maxReadsPerFile) return undefined
    return push({ type: 'read', path: rel, tool: meta.tool, at: meta.at })
  }

  /**
   * A command finished. `status` must be decided by the caller from the real
   * exit code — a "passed" that the ledger invented would be worse than no
   * ledger at all.
   */
  function recordVerification({ command, kind, status, files, exitCode, at, note } = {}) {
    if (typeof command !== 'string' || command.length === 0) return undefined
    const resolved = VERIFICATION_STATUSES.includes(status) ? status : 'blocked'
    return push({
      type: 'verification',
      command,
      kind,
      status: resolved,
      files: Array.isArray(files) ? files : undefined,
      exitCode: Number.isFinite(exitCode) ? exitCode : undefined,
      note,
      at
    })
  }

  function recordGit(command, meta = {}) {
    return push({ type: 'git', command, path: meta.path, at: meta.at })
  }

  function note(text) {
    return push({ type: 'note', note: String(text).slice(0, 500) })
  }

  /** Drop every event about one path (a discarded draft should not hold the gate). */
  function forget(path) {
    const rel = relPath(path)
    const before = events.length
    events = events.filter((e) => e.path !== rel && !(e.files ?? []).includes(rel))
    return before - events.length
  }

  function getEvents() {
    return events.slice()
  }

  /** Files this session has written. Sorted for stable output. */
  function ownedFiles() {
    const set = new Set()
    for (const e of events) {
      if ((e.type === 'write' || e.type === 'git') && e.path !== undefined) set.add(e.path)
    }
    return [...set].sort()
  }

  function verifications() {
    return events.filter((e) => e.type === 'verification')
  }

  /** The last write to a path, as an ordering pair. */
  function lastWriteAt(path) {
    let last = undefined
    for (const e of events) {
      if (e.type !== 'write' || e.path !== path) continue
      if (last === undefined || isAfter(e, last)) last = e
    }
    return last
  }

  /** `(at, seq)` ordering: later wall-clock, or the same tick and a later entry. */
  function isAfter(candidate, reference) {
    if (candidate.at !== reference.at) return candidate.at > reference.at
    return (candidate.seq ?? 0) > (reference.seq ?? 0)
  }

  /**
   * Does this verification cover this file?
   * A verification with no `files` is global: it covers everything written
   * before it, which is the `make build` case.
   */
  function covers(verification, path) {
    if (verification.files === undefined || verification.files.length === 0) return true
    return verification.files.includes(path)
  }

  /**
   * Per-file attribution: the newest covering verification that ran after the
   * file's last write. This is the number the gate reads.
   */
  function attribute() {
    const all = verifications()
    return ownedFiles().map((path) => {
      const written = lastWriteAt(path)
      let newest
      for (const v of all) {
        if (!covers(v, path)) continue
        // A check that ran before the last write proves nothing about that
        // write, so the comparison is per file and ordered by (at, seq).
        if (written !== undefined && !isAfter(v, written)) continue
        if (newest === undefined || isAfter(v, newest)) newest = v
      }
      return {
        path,
        writtenAt: written === undefined ? null : written.at,
        status: newest === undefined ? 'unverified' : newest.status,
        command: newest?.command,
        verifiedAt: newest?.at ?? null
      }
    })
  }

  /**
   * Overall readiness. Ordering matters and is deliberately strict:
   * a failed check outranks everything, and `blocked` never masks an
   * unverified file — "the toolchain was missing" is not a pass.
   */
  function readiness() {
    const files = attribute()
    if (files.length === 0) {
      return { canDeliver: true, level: 'verified', reason: 'no files changed in this session', files: [] }
    }
    const failed = files.filter((f) => f.status === 'failed')
    if (failed.length > 0) {
      return {
        canDeliver: false,
        level: 'failed',
        reason: `${failed.length} file(s) changed after a verification that failed: ${failed.map((f) => f.path).join(', ')}`,
        files
      }
    }
    const unverified = files.filter((f) => f.status === 'unverified')
    if (unverified.length > 0) {
      return {
        canDeliver: false,
        level: 'unverified',
        reason: `${unverified.length} of ${files.length} changed file(s) have no verification after their last write: ${unverified.map((f) => f.path).join(', ')}`,
        files
      }
    }
    const blocked = files.filter((f) => f.status === 'blocked')
    if (blocked.length > 0) {
      return {
        canDeliver: true,
        level: 'external_blocked',
        reason: `verification could not run for ${blocked.length} file(s): ${blocked.map((f) => f.path).join(', ')}`,
        files
      }
    }
    return { canDeliver: true, level: 'verified', reason: `all ${files.length} changed file(s) verified`, files }
  }

  function summary() {
    const owned = ownedFiles()
    const verifs = verifications()
    const state = readiness()
    const reads = events.filter((e) => e.type === 'read')
    return {
      eventCount: events.length,
      droppedEvents: dropped,
      ownedFileCount: owned.length,
      ownedFiles: owned,
      readCount: reads.length,
      verificationCount: verifs.length,
      lastVerification: verifs.length > 0 ? verifs[verifs.length - 1] : undefined,
      deliveries: state.level,
      canDeliver: state.canDeliver,
      reason: state.reason,
      firstEventAt: events.length > 0 ? events[0].at : null,
      lastEventAt: events.length > 0 ? events[events.length - 1].at : null
    }
  }

  function reset() {
    events = []
    dropped = 0
  }

  return {
    record,
    recordWrite,
    recordRead,
    recordVerification,
    recordGit,
    note,
    forget,
    getEvents,
    ownedFiles,
    verifications,
    lastWriteAt,
    attribute,
    readiness,
    summary,
    reset
  }
}
