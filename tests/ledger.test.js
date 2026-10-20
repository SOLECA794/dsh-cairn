/**
 * `lib/ledger.js` — what the gate actually reads.
 *
 * The whole file exists to make one question answerable without trusting the
 * model: *is this specific file verified as of its last write?* The tests below
 * are mostly about the ways a naive counter gets that wrong.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  DELIVERY_LEVELS,
  LEDGER_DEFAULTS,
  LEDGER_EVENT_TYPES,
  VERIFICATION_STATUSES,
  createLedger
} from '../lib/ledger.js'

/**
 * A ledger with a controllable clock.
 *
 * The default root is `/repo` so the tests can write the absolute-looking paths
 * a real session sees and still assert on the root-relative form the ledger
 * actually stores.
 */
function ledgerAt(start = 1000, options = {}) {
  const clock = { now: start }
  const ledger = createLedger({ root: '/repo', ...options, now: () => clock.now })
  return { ledger, clock, tick: (ms = 10) => { clock.now += ms; return clock.now } }
}

test('the exported vocabularies are frozen and complete', () => {
  assert.deepEqual([...LEDGER_EVENT_TYPES], ['write', 'read', 'verification', 'git', 'note'])
  assert.deepEqual([...VERIFICATION_STATUSES], ['passed', 'failed', 'blocked'])
  assert.deepEqual(
    [...DELIVERY_LEVELS],
    ['verified', 'failed', 'blocked', 'unverified', 'external_blocked']
  )
  assert.equal(LEDGER_DEFAULTS.maxEvents, 4000)
})

test('an empty ledger is deliverable and says why', () => {
  const { ledger } = ledgerAt()
  const state = ledger.readiness()
  assert.equal(state.canDeliver, true)
  assert.equal(state.level, 'verified')
  assert.equal(state.reason, 'no files changed in this session')
  assert.deepEqual(state.files, [])
})

test('a write makes the file unverified', () => {
  const { ledger } = ledgerAt()
  ledger.recordWrite('/repo/src/a.rs')
  const state = ledger.readiness()
  assert.equal(state.level, 'unverified')
  assert.equal(state.canDeliver, false)
  assert.deepEqual(state.files.map((f) => f.path), ['src/a.rs'])
  assert.equal(state.files[0].status, 'unverified')
})

test('a verification after the write verifies it', () => {
  const { ledger, tick } = ledgerAt()
  ledger.recordWrite('/repo/src/a.rs')
  tick()
  ledger.recordVerification({ command: 'cargo check', kind: 'typecheck', status: 'passed' })
  const state = ledger.readiness()
  assert.equal(state.level, 'verified')
  assert.equal(state.canDeliver, true)
  assert.equal(state.files[0].command, 'cargo check')
})

test('a verification BEFORE the last write proves nothing about that write', () => {
  const { ledger, tick } = ledgerAt()
  ledger.recordVerification({ command: 'cargo check', kind: 'typecheck', status: 'passed' })
  tick()
  ledger.recordWrite('/repo/src/a.rs')
  assert.equal(ledger.readiness().level, 'unverified')
  assert.equal(ledger.readiness().canDeliver, false)
})

test('one check after many writes covers all of them', () => {
  const { ledger, tick } = ledgerAt()
  ledger.recordWrite('/repo/src/a.rs')
  ledger.recordWrite('/repo/src/b.rs')
  ledger.recordWrite('/repo/src/c.rs')
  tick()
  ledger.recordVerification({ command: 'make build', status: 'passed' })
  const state = ledger.readiness()
  assert.equal(state.level, 'verified')
  assert.equal(state.files.length, 3)
})

test('a check after five of six writes leaves exactly the sixth unverified', () => {
  const { ledger, tick } = ledgerAt()
  for (const f of ['a', 'b', 'c', 'd', 'e']) ledger.recordWrite(`/repo/${f}.rs`)
  tick()
  ledger.recordVerification({ command: 'make build', status: 'passed' })
  tick()
  ledger.recordWrite('/repo/f.rs')

  const state = ledger.readiness()
  assert.equal(state.level, 'unverified')
  assert.equal(state.canDeliver, false)
  const byPath = Object.fromEntries(state.files.map((f) => [f.path, f.status]))
  assert.equal(byPath['f.rs'], 'unverified')
  // `attribute()` reports the *verification's own* status, not a verdict word:
  // a file covered by a passing check is 'passed'.
  assert.equal(byPath['a.rs'], 'passed', 'the earlier files stay verified')
  // A ratio would have called this "83% verified", which ships.
  assert.match(state.reason, /1 of 6/)
})

test('a failed verification outranks unverified and blocks delivery', () => {
  const { ledger, tick } = ledgerAt()
  ledger.recordWrite('/repo/src/a.rs')
  ledger.recordWrite('/repo/src/b.rs')
  tick()
  ledger.recordVerification({ command: 'cargo test', status: 'failed', exitCode: 101 })
  const state = ledger.readiness()
  assert.equal(state.level, 'failed')
  assert.equal(state.canDeliver, false)
  assert.match(state.reason, /a\.rs/)
  assert.match(state.reason, /b\.rs/)
})

test('failed outranks unverified even when the failed files are fewer', () => {
  const { ledger, tick } = ledgerAt()
  ledger.recordWrite('/repo/a.rs')
  tick()
  ledger.recordVerification({ command: 'make', status: 'failed', files: ['/repo/a.rs'] })
  tick()
  ledger.recordWrite('/repo/b.rs') // b is unverified, a is failed
  const state = ledger.readiness()
  assert.equal(state.level, 'failed', 'a known failure must not be hidden behind "unverified"')
})

test('blocked never masks an unverified file', () => {
  const { ledger, tick } = ledgerAt()
  ledger.recordWrite('/repo/a.rs')
  ledger.recordWrite('/repo/b.rs')
  tick()
  // Only a is covered by the blocked attempt; b was never attempted.
  ledger.recordVerification({ command: 'make', status: 'blocked', files: ['/repo/a.rs'] })
  const state = ledger.readiness()
  assert.equal(state.level, 'unverified', '"the toolchain was missing" is not a pass')
  assert.equal(state.canDeliver, false)
})

test('all blocked reports external_blocked but stays deliverable', () => {
  const { ledger, tick } = ledgerAt()
  ledger.recordWrite('/repo/a.rs')
  tick()
  ledger.recordVerification({ command: 'docker build', status: 'blocked' })
  const state = ledger.readiness()
  assert.equal(state.level, 'external_blocked')
  assert.equal(state.canDeliver, true, 'a missing toolchain is not the model\'s fault')
  assert.match(state.reason, /could not run/)
})

test('an unknown verification status is coerced to blocked, not passed', () => {
  const { ledger, tick } = ledgerAt()
  ledger.recordWrite('/repo/a.rs')
  tick()
  const event = ledger.recordVerification({ command: 'x', status: 'looks-fine' })
  assert.equal(event.status, 'blocked')
})

test('recordVerification refuses an empty command (nothing to attribute)', () => {
  const { ledger } = ledgerAt()
  assert.equal(ledger.recordVerification({ status: 'passed' }), undefined)
  assert.equal(ledger.recordVerification({ command: '', status: 'passed' }), undefined)
  assert.equal(ledger.verifications().length, 0)
})

test('a scoped verification only covers the files it names', () => {
  const { ledger, tick } = ledgerAt()
  ledger.recordWrite('/repo/a.rs')
  ledger.recordWrite('/repo/b.rs')
  tick()
  ledger.recordVerification({ command: 'pytest a', status: 'passed', files: ['/repo/a.rs'] })
  const byPath = Object.fromEntries(ledger.attribute().map((f) => [f.path, f.status]))
  assert.equal(byPath['a.rs'], 'passed')
  assert.equal(byPath['b.rs'], 'unverified')
})

test('the newest covering verification wins', () => {
  const { ledger, tick } = ledgerAt()
  ledger.recordWrite('/repo/a.rs')
  tick()
  ledger.recordVerification({ command: 'first', status: 'passed' })
  tick()
  ledger.recordVerification({ command: 'second', status: 'failed' })
  const [entry] = ledger.attribute()
  assert.equal(entry.status, 'failed')
  assert.equal(entry.command, 'second')
})

test('a later pass clears an earlier failure', () => {
  const { ledger, tick } = ledgerAt()
  ledger.recordWrite('/repo/a.rs')
  tick()
  ledger.recordVerification({ command: 'first', status: 'failed' })
  tick()
  ledger.recordVerification({ command: 'second', status: 'passed' })
  assert.equal(ledger.readiness().level, 'verified')
})

test('paths are normalised to root-relative POSIX on the way in', () => {
  const { ledger } = ledgerAt(1000, { root: 'C:\\repo' })
  ledger.recordWrite('C:\\repo\\src\\a.rs')
  ledger.recordVerification({ command: 'make', status: 'passed', files: ['C:\\repo\\src\\a.rs'] })
  assert.deepEqual(ledger.ownedFiles(), ['src/a.rs'])
  assert.equal(ledger.verifications()[0].files[0], 'src/a.rs')
})

test('a path outside the root is kept as given rather than claimed as inside', () => {
  const { ledger } = ledgerAt(1000, { root: 'C:\\repo' })
  ledger.recordWrite('C:\\other\\x.rs')
  assert.equal(ledger.ownedFiles()[0], 'C:/other/x.rs')
})

test('recordRead is capped per file so a loop cannot flood the ledger', () => {
  const { ledger } = ledgerAt()
  for (let i = 0; i < LEDGER_DEFAULTS.maxReadsPerFile + 10; i += 1) {
    ledger.recordRead('/repo/a.rs')
  }
  assert.equal(ledger.getEvents().filter((e) => e.type === 'read').length, LEDGER_DEFAULTS.maxReadsPerFile)
  // A different file still records.
  assert.ok(ledger.recordRead('/repo/b.rs') !== undefined)
})

test('the event ring drops the oldest events under pressure', () => {
  const clock = { now: 0 }
  const ledger = createLedger({ maxEvents: 3, root: '/repo', now: () => clock.now })
  for (let i = 0; i < 5; i += 1) {
    clock.now += 1
    ledger.recordWrite(`/repo/f${i}.rs`)
  }
  const summary = ledger.summary()
  assert.equal(summary.eventCount, 3)
  assert.equal(summary.droppedEvents, 2)
  assert.deepEqual(ledger.ownedFiles(), ['f2.rs', 'f3.rs', 'f4.rs'])
})

test('forget drops every event about a path, including coverage lists', () => {
  const { ledger, tick } = ledgerAt()
  ledger.recordWrite('/repo/a.rs')
  ledger.recordWrite('/repo/b.rs')
  tick()
  ledger.recordVerification({ command: 'make', status: 'passed', files: ['/repo/a.rs', '/repo/b.rs'] })
  assert.equal(ledger.forget('/repo/a.rs'), 2, 'the write and the coverage entry')
  assert.deepEqual(ledger.ownedFiles(), ['b.rs'])
})

test('forget of an unknown path is a no-op', () => {
  const { ledger } = ledgerAt()
  ledger.recordWrite('/repo/a.rs')
  assert.equal(ledger.forget('/repo/nope.rs'), 0)
  assert.equal(ledger.ownedFiles().length, 1)
})

test('git events create ownership and note events do not', () => {
  const { ledger } = ledgerAt()
  ledger.recordGit('git commit', { path: '/repo/a.rs' })
  ledger.note('a thought')
  assert.deepEqual(ledger.ownedFiles(), ['a.rs'])
})

test('record rejects an unknown type instead of storing junk', () => {
  const { ledger } = ledgerAt()
  assert.equal(ledger.record({ type: 'explosion' }), undefined)
  assert.equal(ledger.record(null), undefined)
  assert.ok(ledger.record({ type: 'note', note: 'ok' }) !== undefined)
})

test('summary reports the shape the status tool renders', () => {
  const { ledger, tick } = ledgerAt()
  ledger.recordWrite('/repo/a.rs')
  ledger.recordRead('/repo/a.rs')
  tick()
  ledger.recordVerification({ command: 'make', status: 'passed' })
  const summary = ledger.summary()
  assert.equal(summary.ownedFileCount, 1)
  assert.equal(summary.readCount, 1)
  assert.equal(summary.verificationCount, 1)
  assert.equal(summary.deliveries, 'verified')
  assert.equal(summary.canDeliver, true)
  assert.equal(summary.lastVerification.command, 'make')
  assert.ok(summary.lastEventAt >= summary.firstEventAt)
})

test('reset clears everything', () => {
  const { ledger } = ledgerAt()
  ledger.recordWrite('/repo/a.rs')
  ledger.reset()
  assert.deepEqual(ledger.getEvents(), [])
  assert.deepEqual(ledger.ownedFiles(), [])
  assert.equal(ledger.summary().droppedEvents, 0)
  assert.equal(ledger.readiness().level, 'verified')
})

test('getEvents hands out a copy, not the live ring', () => {
  const { ledger } = ledgerAt()
  ledger.recordWrite('/repo/a.rs')
  const events = ledger.getEvents()
  events.push({ type: 'write', path: 'injected.rs' })
  assert.equal(ledger.getEvents().length, 1)
})
