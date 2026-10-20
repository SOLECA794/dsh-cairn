/**
 * `lib/pheromone.js` — cross-session memory that has to expire on its own.
 *
 * Two properties are load-bearing and both are tested adversarially: a signal
 * that is never re-observed must fade (otherwise the store accumulates
 * superstition), and a signal that keeps being observed must climb (otherwise
 * ranking is meaningless). Persistence gets its own tests because the failure
 * mode — "I saved it" and it is not on disk — is silent.
 */

import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import {
  PHEROMONE_DEFAULTS,
  PHEROMONE_HALF_LIVES,
  PHEROMONE_SIGNALS,
  createPheromoneStore,
  decayedStrength
} from '../lib/pheromone.js'

const DAY = 86_400_000

function scratch() {
  const dir = mkdtempSync(join(tmpdir(), 'cairn-pheromone-'))
  return { dir, done: () => rmSync(dir, { recursive: true, force: true }) }
}

/** A store with a controllable clock and no debounce timer. */
function storeAt(start = 1_000_000, options = {}) {
  const clock = { now: start }
  const store = createPheromoneStore({
    now: () => clock.now,
    defaults: { debounceMs: 0 },
    ...options
  })
  return { store, clock, advance: (ms) => { clock.now += ms; return clock.now } }
}

test('the signal vocabulary and half-lives are frozen and complete', () => {
  assert.deepEqual(
    [...PHEROMONE_SIGNALS],
    ['fragile', 'well-tested', 'performance-critical', 'refactor-candidate', 'dead-end', 'entry-point', 'coupling-hub']
  )
  for (const signal of PHEROMONE_SIGNALS) {
    assert.ok(PHEROMONE_HALF_LIVES[signal] > 0, `${signal} needs a half-life`)
  }
  // A dead-end ages out fast; a performance property survives a quarter.
  assert.ok(PHEROMONE_HALF_LIVES['dead-end'] < PHEROMONE_HALF_LIVES['performance-critical'])
  assert.equal(PHEROMONE_DEFAULTS.capacity, 200)
})

test('decayedStrength halves over one half-life and is 0 for junk', () => {
  const entry = { strength: 1, depositedAt: 0, halfLife: 1000 }
  assert.equal(decayedStrength(entry, 0), 1)
  assert.equal(decayedStrength(entry, 1000), 0.5)
  assert.equal(decayedStrength(entry, 2000), 0.25)
  assert.equal(decayedStrength(null), 0)
  assert.equal(decayedStrength({ strength: 0 }, 0), 0)
  // Clock skew must not resurrect a signal.
  assert.equal(decayedStrength(entry, -5000), 1)
})

test('deposit stores an entry with the signal\'s half-life', () => {
  const { store } = storeAt()
  const entry = store.deposit({ path: 'src/a.rs', signal: 'fragile', strength: 0.5, context: 'broke twice' })
  assert.equal(entry.path, 'src/a.rs')
  assert.equal(entry.signal, 'fragile')
  assert.equal(entry.strength, 0.5)
  assert.equal(entry.halfLife, PHEROMONE_HALF_LIVES.fragile)
  assert.equal(entry.context, 'broke twice')
  assert.equal(store.size, 1)
})

test('deposit rejects an unknown signal or an empty path', () => {
  const { store } = storeAt()
  assert.equal(store.deposit({ path: 'a.rs', signal: 'smells-funny' }), undefined)
  assert.equal(store.deposit({ path: '', signal: 'fragile' }), undefined)
  assert.equal(store.deposit({ signal: 'fragile' }), undefined)
  assert.equal(store.deposit(null), undefined)
  assert.equal(store.size, 0)
})

test('deposit reinforces additively, capped at 1', () => {
  const { store } = storeAt()
  store.deposit({ path: 'a.rs', signal: 'fragile', strength: 0.4 })
  store.deposit({ path: 'a.rs', signal: 'fragile', strength: 0.4 })
  assert.equal(store.size, 1, 'the same path+signal is one entry')
  assert.equal(store.query()[0].strength, 0.8)
  store.deposit({ path: 'a.rs', signal: 'fragile', strength: 0.9 })
  assert.equal(store.query()[0].strength, 1)
})

test('reinforcement restarts the clock from the decayed value', () => {
  const { store, advance } = storeAt(0)
  store.deposit({ path: 'a.rs', signal: 'fragile', strength: 1, at: 0 })
  advance(DAY * 7) // exactly one half-life for `fragile`
  store.deposit({ path: 'a.rs', signal: 'fragile', strength: 0.25 })
  // 0.5 decayed + 0.25 added, and depositedAt is now.
  const [entry] = store.query()
  assert.equal(Number(entry.strength.toFixed(4)), 0.75)
  assert.equal(entry.depositedAt, DAY * 7)
})

test('a signal that is never re-observed decays away', () => {
  const { store, advance } = storeAt(0)
  store.deposit({ path: 'a.rs', signal: 'dead-end', strength: 1, at: 0 })
  advance(DAY * 7)
  const [entry] = store.query()
  assert.ok(entry.current < 0.6, `expected decay, got ${entry.current}`)
  advance(DAY * 30)
  assert.ok(store.query()[0].current < 0.06)
})

test('prune removes entries below the threshold', () => {
  const { store, advance } = storeAt(0)
  store.deposit({ path: 'a.rs', signal: 'dead-end', strength: 0.2, at: 0 })
  store.deposit({ path: 'b.rs', signal: 'well-tested', strength: 1, at: 0 })
  advance(DAY * 60)
  assert.ok(store.prune({ persist: false }) >= 1)
  assert.equal(store.size, 1)
  assert.equal(store.query()[0].path, 'b.rs')
})

test('query filters by signal, prefix, and minimum strength', () => {
  const { store } = storeAt(0)
  store.deposit({ path: 'src/a.rs', signal: 'fragile', strength: 0.9, at: 0 })
  store.deposit({ path: 'src/b.rs', signal: 'well-tested', strength: 0.8, at: 0 })
  store.deposit({ path: 'docs/c.md', signal: 'fragile', strength: 0.3, at: 0 })

  assert.equal(store.query({ signal: 'fragile' }).length, 2)
  assert.equal(store.query({ pathPrefix: 'src/' }).length, 2)
  assert.equal(store.query({ minStrength: 0.5 }).length, 2)
  assert.equal(store.query({ signal: 'fragile', pathPrefix: 'docs/' }).length, 1)
})

test('query sorts by descending current strength', () => {
  const { store } = storeAt(0)
  store.deposit({ path: 'a.rs', signal: 'fragile', strength: 0.2, at: 0 })
  store.deposit({ path: 'b.rs', signal: 'fragile', strength: 0.9, at: 0 })
  assert.deepEqual(store.query({ signal: 'fragile' }).map((e) => e.path), ['b.rs', 'a.rs'])
})

test('forPaths is restricted to the given set and honours the limit', () => {
  const { store } = storeAt(0)
  store.deposit({ path: 'a.rs', signal: 'fragile', strength: 0.9, at: 0 })
  store.deposit({ path: 'b.rs', signal: 'fragile', strength: 0.8, at: 0 })
  store.deposit({ path: 'c.rs', signal: 'fragile', strength: 0.7, at: 0 })
  assert.deepEqual(store.forPaths(['a.rs', 'b.rs']).map((e) => e.path), ['a.rs', 'b.rs'])
  assert.equal(store.forPaths(['a.rs', 'b.rs'], { limit: 1 }).length, 1)
  assert.deepEqual(store.forPaths([]), [])
  assert.deepEqual(store.forPaths(undefined), [])
})

test('capacity evicts the weakest, not the oldest', () => {
  const { store } = storeAt(0)
  for (let i = 0; i < 5; i += 1) {
    store.deposit({ path: `f${i}.rs`, signal: 'fragile', strength: 0.1 * (i + 1), at: 0 })
  }
  const small = createPheromoneStore({ now: () => 0, defaults: { capacity: 3, debounceMs: 0 }, autoLoad: false })
  for (let i = 0; i < 5; i += 1) {
    small.deposit({ path: `f${i}.rs`, signal: 'fragile', strength: 0.1 * (i + 1), at: 0 })
  }
  assert.equal(small.size, 3)
  const kept = small.query().map((e) => e.path).sort()
  assert.deepEqual(kept, ['f2.rs', 'f3.rs', 'f4.rs'], 'the three strongest survive')
})

test('forget removes one signal or every signal on a path', () => {
  const { store } = storeAt(0)
  store.deposit({ path: 'a.rs', signal: 'fragile', at: 0 })
  store.deposit({ path: 'a.rs', signal: 'well-tested', at: 0 })
  assert.equal(store.forget('a.rs', 'fragile'), 1)
  assert.equal(store.size, 1)
  assert.equal(store.forget('a.rs'), 1)
  assert.equal(store.size, 0)
  assert.equal(store.forget('a.rs'), 0)
})

test('a memory-only store persists nothing and reports that', () => {
  const { store } = storeAt()
  store.deposit({ path: 'a.rs', signal: 'fragile' })
  assert.equal(store.flush(), true)
  const summary = store.summary()
  assert.equal(summary.persisted, false)
  assert.equal(summary.filePath, undefined)
  assert.equal(summary.entryCount, 1)
})

test('a persisted store writes on flush and reloads what it wrote', () => {
  const { dir, done } = scratch()
  try {
    const file = join(dir, 'signals.json')
    const { store, advance } = storeAt(0, { filePath: file })
    store.deposit({ path: 'src/a.rs', signal: 'fragile', strength: 0.7, context: 'broke' })
    advance(1000)
    assert.equal(store.flush(), true)
    assert.equal(existsSync(file), true)

    const saved = JSON.parse(readFileSync(file, 'utf8'))
    assert.equal(saved.version, 1)
    assert.equal(saved.entries.length, 1)

    const reopened = createPheromoneStore({ filePath: file, now: () => 1000, defaults: { debounceMs: 0 } })
    assert.equal(reopened.size, 1)
    assert.equal(reopened.query()[0].path, 'src/a.rs')
    assert.equal(reopened.query()[0].context, 'broke')
    reopened.dispose()
    store.dispose()
  } finally {
    done()
  }
})

test('a corrupt file loads as empty instead of throwing', () => {
  const { dir, done } = scratch()
  try {
    const file = join(dir, 'signals.json')
    writeFileSync(file, '{ not json')
    const store = createPheromoneStore({ filePath: file, defaults: { debounceMs: 0 } })
    assert.equal(store.size, 0)
    store.dispose()
  } finally {
    done()
  }
})

test('load drops entries the current build does not understand', () => {
  const { dir, done } = scratch()
  try {
    const file = join(dir, 'signals.json')
    writeFileSync(
      file,
      JSON.stringify({
        version: 1,
        entries: [
          { path: 'a.rs', signal: 'fragile', strength: 0.5, depositedAt: Date.now(), halfLife: 1000 },
          { path: 'b.rs', signal: 'not-a-signal', strength: 0.5, depositedAt: Date.now() },
          { path: '', signal: 'fragile', strength: 0.5, depositedAt: Date.now() },
          { path: 'c.rs', signal: 'fragile', strength: 0.5, depositedAt: 'never' }
        ]
      })
    )
    const store = createPheromoneStore({ filePath: file, defaults: { debounceMs: 0 } })
    assert.equal(store.size, 1)
    assert.equal(store.query()[0].path, 'a.rs')
    store.dispose()
  } finally {
    done()
  }
})

test('flush keeps the dirty flag when the write fails', () => {
  const { dir, done } = scratch()
  try {
    // A directory in place of the file makes the atomic rename fail.
    const file = join(dir, 'blocked.json')
    const { store } = storeAt(0, { filePath: file })
    mkdirSync(file, { recursive: true })
    store.deposit({ path: 'a.rs', signal: 'fragile' })
    assert.equal(store.flush(), false)
    const summary = store.summary()
    assert.equal(summary.dirty, true, 'a lost write must stay dirty so the next flush retries')
    assert.equal(summary.lastWriteOk, false)
  } finally {
    done()
  }
})

test('dispose flushes and stops the timer', () => {
  const { dir, done } = scratch()
  try {
    const file = join(dir, 'signals.json')
    const store = createPheromoneStore({ filePath: file, defaults: { debounceMs: 50 } })
    store.deposit({ path: 'a.rs', signal: 'fragile' })
    store.dispose()
    assert.equal(existsSync(file), true, 'dispose must not drop an unsaved signal')
    const reopened = createPheromoneStore({ filePath: file })
    assert.equal(reopened.size, 1)
    reopened.dispose()
  } finally {
    done()
  }
})

test('reset empties the store and the file', () => {
  const { dir, done } = scratch()
  try {
    const file = join(dir, 'signals.json')
    const store = createPheromoneStore({ filePath: file, defaults: { debounceMs: 0 } })
    store.deposit({ path: 'a.rs', signal: 'fragile' })
    store.flush()
    store.reset()
    assert.equal(store.size, 0)
    assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')).entries, [])
    store.dispose()
  } finally {
    done()
  }
})

test('context is clipped to the documented bound', () => {
  const { store } = storeAt()
  store.deposit({ path: 'a.rs', signal: 'fragile', context: 'x'.repeat(1000) })
  assert.equal(store.query()[0].context.length, PHEROMONE_DEFAULTS.maxContextChars)
})

test('summary counts by signal', () => {
  const { store } = storeAt(0)
  store.deposit({ path: 'a.rs', signal: 'fragile', at: 0 })
  store.deposit({ path: 'b.rs', signal: 'fragile', at: 0 })
  store.deposit({ path: 'c.rs', signal: 'entry-point', at: 0 })
  const summary = store.summary()
  assert.equal(summary.entryCount, 3)
  assert.deepEqual(summary.bySignal, { fragile: 2, 'entry-point': 1 })
  assert.ok(summary.totalStrength > 0)
})
