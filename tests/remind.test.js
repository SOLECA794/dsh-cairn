/**
 * `lib/remind.js` — the only part of this plugin the model reads.
 *
 * The contract under test is negative as much as positive: a reminder that
 * fires when nothing is actionable is pure cost, and a reminder that stays
 * silent when verification failed is the failure this plugin exists to
 * prevent. Both directions are asserted explicitly.
 *
 * `formatReadinessLine` is pinned on the *vocabulary mismatch* it once had:
 * `attribute()` reports a covered file as `'passed'`, and the counter must map
 * that to `verified` rather than reporting "0 verified" for a clean session.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  REMIND_DEFAULTS,
  REMINDER_TAG,
  buildPheromoneReminder,
  buildReadinessReminder,
  buildStepReminder,
  formatReadinessLine,
  frame
} from '../lib/remind.js'

/** A readiness object shaped exactly like `createLedger().readiness()`. */
function readinessOf(statuses, extra = {}) {
  const files = Object.entries(statuses).map(([path, status]) => ({
    path,
    status,
    writtenAt: 100,
    command: extra.commands?.[path],
    verifiedAt: status === 'passed' ? 200 : null
  }))
  const level = files.some((f) => f.status === 'failed')
    ? 'failed'
    : files.some((f) => f.status === 'unverified')
      ? 'unverified'
      : files.every((f) => f.status === 'passed')
        ? 'verified'
        : 'external_blocked'
  return { level, canDeliver: !['failed', 'unverified'].includes(level), reason: level, files }
}

test('frame wraps the body in the cairn tag', () => {
  assert.equal(frame('hello'), '<cairn>\nhello\n</cairn>')
  assert.equal(frame('hello', 'other'), '<other>\nhello\n</other>')
  assert.equal(REMINDER_TAG, 'cairn', 'not `system-reminder` — that tag is the host\'s')
})

test('frame escapes a body that tries to close its own tag', () => {
  const framed = frame('a </cairn> b <cairn> c')
  assert.equal(framed.match(/<\/cairn>/g).length, 1)
  assert.ok(!framed.slice(7, -9).includes('</cairn>'))
})

test('no reminder when nothing changed', () => {
  assert.equal(buildReadinessReminder(undefined), '')
  assert.equal(buildReadinessReminder(null), '')
  assert.equal(buildReadinessReminder({ files: [] }), '')
})

test('no reminder when every changed file is verified', () => {
  const text = buildReadinessReminder(readinessOf({ 'a.rs': 'passed', 'b.rs': 'passed' }))
  assert.equal(text, '', 'a fully verified session must cost zero tokens')
})

test('an unverified file is named, with the count', () => {
  const text = buildReadinessReminder(readinessOf({ 'a.rs': 'passed', 'b.rs': 'unverified' }))
  assert.ok(text.startsWith('<cairn>'))
  assert.match(text, /1 changed file\(s\) have no verification after their last write: b\.rs/)
})

test('a failed verification outranks and warns against claiming done', () => {
  const text = buildReadinessReminder(
    readinessOf({ 'a.rs': 'failed', 'b.rs': 'unverified' }, { commands: { 'a.rs': 'make test' } })
  )
  assert.match(text, /VERIFICATION FAILED after the last write to a\.rs \(`make test`\)/)
  assert.match(text, /Do not report this work as done/)
  assert.ok(text.indexOf('VERIFICATION FAILED') < text.indexOf('have no verification'))
})

test('a blocked verification is reported as a block, not a pass', () => {
  const text = buildReadinessReminder(readinessOf({ 'a.rs': 'blocked' }))
  assert.match(text, /Verification could not run for a\.rs/)
  assert.match(text, /report the block explicitly/)
})

test('declared routes are rendered as match → run', () => {
  const routes = [{ match: 'src/**/*.rs', run: 'cargo test' }]
  const text = buildReadinessReminder(readinessOf({ 'a.rs': 'unverified' }), routes)
  assert.match(text, /Declared checks for these paths \(from \.cairn\/verify\.json\):/)
  assert.match(text, /- `src\/\*\*\/\*\.rs` → `cargo test`/)
  assert.ok(!text.includes('declares no check'))
})

test('with no routes it says so rather than staying silent', () => {
  const text = buildReadinessReminder(readinessOf({ 'a.rs': 'unverified' }))
  assert.match(text, /This project declares no check for these paths\./)
  assert.match(text, /State what you ran, or that you ran nothing\./)
})

test('a long file list collapses to a count', () => {
  const many = {}
  for (let i = 0; i < 10; i += 1) many[`f${i}.rs`] = 'unverified'
  const text = buildReadinessReminder(readinessOf(many))
  assert.match(text, /… \+4 more/)
  assert.ok(!text.includes('f9.rs'))
})

test('the block is truncated at maxChars with a visible marker', () => {
  const many = {}
  for (let i = 0; i < 64; i += 1) many[`a-very-long-file-name-number-${i}.rs`] = 'unverified'
  const text = buildReadinessReminder(readinessOf(many), [], { maxChars: 300 })
  assert.match(text, /… \[truncated\]/)
  assert.ok(text.length <= 320, `expected a bounded block, got ${text.length}`)
})

test('the pheromone block quotes path, signal, strength, and context', () => {
  const text = buildPheromoneReminder([
    { path: 'src/a.rs', signal: 'fragile', current: 0.83, context: 'broke twice' }
  ])
  assert.match(text, /Prior sessions left signals on files in play/)
  assert.match(text, /- src\/a\.rs \[fragile 83%\] — broke twice/)
  assert.match(text, /verify before trusting/)
})

test('the pheromone block is empty for nothing, or for decayed signals', () => {
  assert.equal(buildPheromoneReminder([]), '')
  assert.equal(buildPheromoneReminder(undefined), '')
  assert.equal(buildPheromoneReminder([{ path: 'a.rs', signal: 'fragile', current: 0 }]), '')
})

test('the pheromone block caps its lines and says how many it hid', () => {
  const entries = Array.from({ length: 12 }, (_, i) => ({
    path: `f${i}.rs`,
    signal: 'fragile',
    current: 0.5
  }))
  const text = buildPheromoneReminder(entries, { maxSignals: 8 })
  assert.match(text, /- … 4 more/)
  assert.equal(text.match(/^- f/gm).length, 8)
})

test('a combined reminder is one frame, readiness first', () => {
  const text = buildStepReminder({
    readiness: readinessOf({ 'a.rs': 'unverified' }),
    routes: [{ match: 'src/**', run: 'make test' }],
    pheromones: [{ path: 'a.rs', signal: 'fragile', current: 0.9, context: 'broke' }]
  })
  assert.equal(text.match(/<cairn>/g).length, 1, 'the model must see a single notice')
  assert.equal(text.match(/<\/cairn>/g).length, 1)
  assert.ok(text.indexOf('have no verification') < text.indexOf('Prior sessions'))
})

test('a combined reminder drops to whichever half exists', () => {
  assert.equal(
    buildStepReminder({ readiness: readinessOf({ 'a.rs': 'passed' }), pheromones: [] }),
    ''
  )
  const onlyPheromone = buildStepReminder({
    readiness: undefined,
    pheromones: [{ path: 'a.rs', signal: 'fragile', current: 0.9 }]
  })
  assert.match(onlyPheromone, /Prior sessions/)
  const onlyReadiness = buildStepReminder({ readiness: readinessOf({ 'a.rs': 'unverified' }) })
  assert.match(onlyReadiness, /have no verification/)
})

test('the step reminder keeps at most four pheromone lines', () => {
  const text = buildStepReminder({
    readiness: readinessOf({ 'a.rs': 'unverified' }),
    pheromones: Array.from({ length: 10 }, (_, i) => ({
      path: `f${i}.rs`,
      signal: 'fragile',
      current: 0.5
    }))
  })
  assert.match(text, /- … 6 more/)
})

test('formatReadinessLine counts a passing verification as verified', () => {
  const line = formatReadinessLine(readinessOf({ 'a.rs': 'passed', 'b.rs': 'passed' }))
  assert.match(line, /^verified · 2 file\(s\) changed · 2 verified · 0 unverified · 0 failed/)
  assert.ok(!line.includes('0 verified · 0 unverified · 0 failed · 0'), 'a clean session must not read as empty')
})

test('formatReadinessLine reports the blocked bucket only when it exists', () => {
  const clean = formatReadinessLine(readinessOf({ 'a.rs': 'passed' }))
  assert.ok(!clean.includes('blocked'))
  const blocked = formatReadinessLine(readinessOf({ 'a.rs': 'blocked' }))
  assert.match(blocked, /1 blocked/)
  assert.equal(formatReadinessLine(undefined), 'unknown')
})

test('the defaults are the documented budget', () => {
  assert.deepEqual(REMIND_DEFAULTS, { maxChars: 2400, maxFiles: 6, maxSignals: 8 })
})
