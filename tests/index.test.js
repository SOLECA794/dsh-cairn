/**
 * `lib/index.js` — the plugin itself: wiring, intake, injection, gate.
 *
 * This is the only suite that needs the harness, because `apply()` takes a
 * context and talks to the real registries. `@deepseek-ai/dsh-tools` lives
 * inside a DSH install and cannot be imported from a checkout, so a resolve
 * hook swaps in `tests/stubs/dsh-tools.mjs` before the module is loaded.
 *
 * The behaviours pinned here are the ones that would fail silently in
 * production: a write that never reaches the ledger, a verification attributed
 * to the wrong edit, a reminder that repeats every step, and a gate that either
 * never fires or always fires.
 */

import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { registerHooks } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

/* ------------------------------------------------------------------ *
 * Loading `lib/index.js` with the harness module stubbed out.
 * ------------------------------------------------------------------ */

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === '@deepseek-ai/dsh-tools') {
      return {
        url: new URL('./stubs/dsh-tools.mjs', import.meta.url).href,
        shortCircuit: true
      }
    }
    return nextResolve(specifier, context)
  }
})

const cairn = await import('../lib/index.js')

/* ------------------------------------------------------------------ *
 * Harness stand-ins
 * ------------------------------------------------------------------ */

/** A project on disk, with an optional declared check. */
function project(verifyJson) {
  const root = mkdtempSync(join(tmpdir(), 'cairn-index-'))
  if (verifyJson !== undefined) {
    mkdirSync(join(root, '.cairn'), { recursive: true })
    writeFileSync(
      join(root, '.cairn', 'verify.json'),
      typeof verifyJson === 'string' ? verifyJson : JSON.stringify(verifyJson)
    )
  }
  return root
}

function mockContext() {
  const listeners = new Map()
  const registeredTools = []
  const effects = []
  const warnings = []
  const ctx = {
    logger: {
      warn: (message) => warnings.push(message),
      info: () => {},
      debug: () => {},
      error: () => {}
    },
    on(event, handler) {
      if (!listeners.has(event)) listeners.set(event, [])
      listeners.get(event).push(handler)
    },
    effect(setup) {
      effects.push(setup)
    },
    tools: {
      register(tool) {
        registeredTools.push(tool)
      }
    }
  }
  return {
    ctx,
    listeners,
    registeredTools,
    effects,
    warnings,
    /** Run every handler the plugin registered for one event. */
    fire: (event, ...args) => (listeners.get(event) ?? []).map((handler) => handler(...args)),
    tool: (name) => registeredTools.find((tool) => tool.name === name)
  }
}

/** An agent whose session header names the project root. */
function agentFor(root) {
  return { id: 'agent-1', session: { header: { cwd: root } } }
}

/** The `tools/post-execute` seam: decision in, decision out. */
function postExecute(harness, exec, result, decision = { kind: 'accept' }) {
  const [handler] = harness.listeners.get('tools/post-execute')
  return handler(exec, result, async () => decision)
}

const shellExec = (command, agent) => ({ name: 'pwsh', arguments: { command }, agent, callId: 'c1' })
const readExec = (agent) => ({ name: 'read', arguments: { path: 'a.rs' }, agent, callId: 'c2' })
const writeExec = (agent) => ({ name: 'write', arguments: { path: 'a.rs' }, agent, callId: 'c3' })

/** Register a write through the `fs/observed` seam, as the harness would. */
function observeWrite(harness, agent, path, toolName = 'write') {
  harness.fire('fs/observed', { path }, { kind: 'present', version: 'v1' }, { name: toolName, agent })
}

function observeRead(harness, agent, path) {
  harness.fire('fs/observed', { path }, { kind: 'present', version: 'v1' }, { name: 'read', agent })
}

/* ------------------------------------------------------------------ *
 * Identity, config, helpers
 * ------------------------------------------------------------------ */

test('the plugin declares its name and the one service it needs', () => {
  assert.equal(cairn.name, 'dsh-cairn')
  assert.deepEqual(cairn.inject, ['tools'])
})

test('normalizeConfig accepts the nested shape and the flat one', () => {
  const nested = cairn.normalizeConfig({ gate: { mode: 'deny', tools: ['present'], commands: ['git commit'] } })
  const flat = cairn.normalizeConfig({ gateMode: 'deny', gateTools: ['present'], gateCommands: ['git commit'] })
  assert.equal(nested.gateMode, 'deny')
  assert.deepEqual(nested.gateTools, ['present'])
  assert.deepEqual(flat.gateTools, ['present'])
  assert.equal(cairn.normalizeConfig({}).gateMode, 'remind')
})

test('normalizeConfig rejects nonsense instead of trusting it', () => {
  assert.equal(cairn.normalizeConfig({ gateMode: 'obliterate' }).gateMode, 'remind')
  assert.equal(cairn.normalizeConfig({ gateMode: 42 }).gateMode, 'remind')
  assert.deepEqual(cairn.normalizeConfig({ gateTools: [] }).gateTools, ['present'], 'an empty list must not disable the gate')
  assert.deepEqual(cairn.normalizeConfig({ gateTools: [1, ''] }).gateTools, ['present'])
  assert.equal(cairn.normalizeConfig({ fragileWrites: 0 }).fragileWrites, 3)
  assert.equal(cairn.normalizeConfig({ fragileWrites: -5 }).fragileWrites, 3)
  assert.equal(cairn.normalizeConfig({ fragileWrites: 1e9 }).fragileWrites, 100)
  assert.equal(cairn.normalizeConfig({ pheromone: { persist: false } }).pheromonePersist, false)
  assert.equal(cairn.normalizeConfig({ pheromonePersist: false }).pheromonePersist, false)
  assert.equal(cairn.normalizeConfig(null).enabled, true, 'a null config must not crash apply')
})

test('exitCodeOf reads the harness exit marker, then the error flag', () => {
  assert.equal(cairn.exitCodeOf({ value: { exitCode: 2 } }), 2)
  assert.equal(cairn.exitCodeOf({ value: { exit_code: 0 } }), 0)
  assert.equal(cairn.exitCodeOf({ content: [{ type: 'text', text: 'boom\n[exit code: 1]' }] }), 1)
  assert.equal(cairn.exitCodeOf({ content: [{ type: 'text', text: 'all good' }] }), undefined)
  assert.equal(cairn.exitCodeOf({ isError: true }), 1)
  assert.equal(cairn.exitCodeOf(undefined), undefined)
})

test('rootOf prefers the session header cwd and falls back to the process', () => {
  assert.equal(cairn.rootOf({ session: { header: { cwd: '/repo' } } }), cairn.rootOf({ session: { header: { cwd: '/repo' } } }))
  assert.ok(cairn.rootOf({ session: { header: { cwd: '/repo' } } }).endsWith('repo'))
  assert.ok(cairn.rootOf({ cwd: '/other' }).endsWith('other'))
  assert.equal(cairn.rootOf(undefined), process.cwd())
})

test('pheromonePathFor is per project and stable', () => {
  const a = cairn.pheromonePathFor('/repo/a', '/home/.dsh')
  const b = cairn.pheromonePathFor('/repo/b', '/home/.dsh')
  assert.equal(a, cairn.pheromonePathFor('/repo/a', '/home/.dsh'), 'the same root must resolve to the same file')
  assert.notEqual(a, b, 'two projects must not share a signal file')
  assert.match(a, /storages[\\/]dsh-cairn[\\/]signals-[0-9a-f]{12}\.json$/)
})

/* ------------------------------------------------------------------ *
 * apply(): registration
 * ------------------------------------------------------------------ */

test('apply registers three tools and four listeners', async () => {
  const harness = mockContext()
  await cairn.apply(harness.ctx, {})
  assert.deepEqual(harness.registeredTools.map((tool) => tool.name).sort(), [
    'cairn_routes',
    'cairn_signal',
    'cairn_status'
  ])
  assert.deepEqual(
    [...harness.listeners.keys()].sort(),
    ['agent/pre-step', 'fs/observed', 'tools/post-execute', 'tools/pre-execute']
  )
  assert.equal(harness.effects.length, 1, 'persistence needs one disposer')
  assert.match(harness.warnings[0], /dsh-cairn: active/)
  assert.match(harness.warnings[0], /spends tokens by design; it saves none/)
})

test('apply with enabled:false wires nothing and says so', async () => {
  const harness = mockContext()
  await cairn.apply(harness.ctx, { enabled: false })
  assert.equal(harness.registeredTools.length, 0)
  assert.equal(harness.listeners.size, 0)
  assert.match(harness.warnings[0], /disabled by config/)
})

test('every tool definition passes the harness shape checks', async () => {
  const harness = mockContext()
  await cairn.apply(harness.ctx, {})
  for (const tool of harness.registeredTools) {
    assert.ok(tool.description.length > 40, `${tool.name} needs a real description`)
    assert.equal(typeof tool.execute, 'function')
    assert.equal(tool.output.schema.type, 'object')
    const rendered = tool.output.render({}, { ok: true })
    assert.equal(rendered[0].type, 'text')
    assert.equal(JSON.parse(rendered[0].text).ok, true)
  }
})

/* ------------------------------------------------------------------ *
 * Evidence intake
 * ------------------------------------------------------------------ */

test('an observed write lands in the ledger as a changed file', async () => {
  const root = project()
  try {
    const harness = mockContext()
    await cairn.apply(harness.ctx, { pheromonePersist: false })
    const agent = agentFor(root)
    observeWrite(harness, agent, join(root, 'src', 'a.rs'))
    observeRead(harness, agent, join(root, 'src', 'b.rs'))

    const status = await harness.tool('cairn_status').execute({}, { agent })
    assert.equal(status.canDeliver, false)
    assert.equal(status.level, 'unverified')
    assert.deepEqual(status.files.map((f) => f.path), ['src/a.rs'], 'a read is not a change')
    assert.match(status.root, /cairn-index-/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('an observation for a file that does not exist is ignored', async () => {
  const root = project()
  try {
    const harness = mockContext()
    await cairn.apply(harness.ctx, { pheromonePersist: false })
    const agent = agentFor(root)
    harness.fire('fs/observed', { path: join(root, 'gone.rs') }, { kind: 'absent' }, { name: 'write', agent })
    const status = await harness.tool('cairn_status').execute({}, { agent })
    assert.deepEqual(status.files, [])
    assert.equal(status.canDeliver, true)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('an unknown actor tool records nothing', async () => {
  const root = project()
  try {
    const harness = mockContext()
    await cairn.apply(harness.ctx, { pheromonePersist: false })
    const agent = agentFor(root)
    harness.fire('fs/observed', { path: join(root, 'a.rs') }, { kind: 'present' }, { name: 'glob', agent })
    const status = await harness.tool('cairn_status').execute({}, { agent })
    assert.deepEqual(status.files, [])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('a declared check is attributed to the file it covers', async () => {
  const root = project({ test: 'npm test', routes: [] })
  try {
    const harness = mockContext()
    await cairn.apply(harness.ctx, { pheromonePersist: false })
    const agent = agentFor(root)
    observeWrite(harness, agent, join(root, 'src', 'a.rs'))
    await postExecute(harness, shellExec('npm test', agent), { content: [{ type: 'text', text: 'ok' }] })
    const status = await harness.tool('cairn_status').execute({}, { agent })
    assert.equal(status.level, 'verified')
    assert.equal(status.canDeliver, true)
    assert.deepEqual(status.verifications.map((v) => v.status), ['passed'])
    assert.equal(status.verifications[0].kind, 'test')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('a failing check is recorded as failed, not as silence', async () => {
  const root = project({ test: 'npm test' })
  try {
    const harness = mockContext()
    await cairn.apply(harness.ctx, { pheromonePersist: false })
    const agent = agentFor(root)
    observeWrite(harness, agent, join(root, 'src', 'a.rs'))
    await postExecute(harness, shellExec('npm test', agent), { content: [{ type: 'text', text: '[exit code: 1]' }] })
    const status = await harness.tool('cairn_status').execute({}, { agent })
    assert.equal(status.level, 'failed')
    assert.equal(status.canDeliver, false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('a route check covers only the files its glob claims', async () => {
  // The laundered-verification case: a subsystem check passes, and because it
  // was recorded as global coverage a changed docs file inherits "verified"
  // from a command that never reads the docs.
  const root = project({
    routes: [
      { match: 'src/mm/**', run: 'make test-shell' },
      { match: 'docs/**', run: 'make docs-check' }
    ]
  })
  try {
    const harness = mockContext()
    await cairn.apply(harness.ctx, { pheromonePersist: false })
    const agent = agentFor(root)
    observeWrite(harness, agent, join(root, 'src', 'mm', 'paging.rs'))
    observeWrite(harness, agent, join(root, 'docs', '01-index.md'))
    await postExecute(harness, shellExec('make test-shell', agent), { content: [{ type: 'text', text: 'ok' }] })
    const status = await harness.tool('cairn_status').execute({ verbose: true }, { agent })
    const byPath = Object.fromEntries(status.files.map((file) => [file.path, file.status]))
    assert.equal(byPath['src/mm/paging.rs'], 'passed')
    assert.equal(byPath['docs/01-index.md'], 'unverified')
    assert.equal(status.canDeliver, false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('a route check that names no changed file is not evidence', async () => {
  const root = project({ routes: [{ match: 'src/mm/**', run: 'make test-shell' }] })
  try {
    const harness = mockContext()
    await cairn.apply(harness.ctx, { pheromonePersist: false })
    const agent = agentFor(root)
    observeWrite(harness, agent, join(root, 'docs', '01-index.md'))
    await postExecute(harness, shellExec('make test-shell', agent), { content: [{ type: 'text', text: 'ok' }] })
    const status = await harness.tool('cairn_status').execute({}, { agent })
    assert.deepEqual(status.verifications, [])
    assert.equal(status.level, 'unverified')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('one command shared by several routes covers every file those routes claim', async () => {
  const root = project({
    routes: [
      { match: 'src/mm/**', run: 'make test-shell' },
      { match: 'src/driver/**', run: 'make test-shell' },
      { match: 'docs/**', run: 'make docs-check' }
    ]
  })
  try {
    const harness = mockContext()
    await cairn.apply(harness.ctx, { pheromonePersist: false })
    const agent = agentFor(root)
    observeWrite(harness, agent, join(root, 'src', 'mm', 'paging.rs'))
    observeWrite(harness, agent, join(root, 'src', 'driver', 'uart.rs'))
    observeWrite(harness, agent, join(root, 'docs', '01-index.md'))
    await postExecute(harness, shellExec('make test-shell', agent), { content: [{ type: 'text', text: 'ok' }] })
    const status = await harness.tool('cairn_status').execute({ verbose: true }, { agent })
    const byPath = Object.fromEntries(status.files.map((file) => [file.path, file.status]))
    assert.equal(byPath['src/mm/paging.rs'], 'passed')
    assert.equal(byPath['src/driver/uart.rs'], 'passed')
    assert.equal(byPath['docs/01-index.md'], 'unverified')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('a declared kind stays project-wide even when routes exist', async () => {
  // `cargo test` reads the whole tree; scoping it to a route glob would leave
  // every other changed file permanently unverified.
  const root = project({ test: 'cargo test', routes: [{ match: 'src/mm/**', run: 'make test-shell' }] })
  try {
    const harness = mockContext()
    await cairn.apply(harness.ctx, { pheromonePersist: false })
    const agent = agentFor(root)
    observeWrite(harness, agent, join(root, 'src', 'mm', 'paging.rs'))
    observeWrite(harness, agent, join(root, 'docs', '01-index.md'))
    await postExecute(harness, shellExec('cargo test', agent), { content: [{ type: 'text', text: 'ok' }] })
    const status = await harness.tool('cairn_status').execute({}, { agent })
    assert.equal(status.level, 'verified')
    assert.equal(status.canDeliver, true)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('an undeclared command is not a verification', async () => {
  const root = project({ test: 'npm test' })
  try {
    const harness = mockContext()
    await cairn.apply(harness.ctx, { pheromonePersist: false })
    const agent = agentFor(root)
    observeWrite(harness, agent, join(root, 'src', 'a.rs'))
    await postExecute(harness, shellExec('ls -la', agent), { content: [{ type: 'text', text: 'files' }] })
    const status = await harness.tool('cairn_status').execute({}, { agent })
    assert.deepEqual(status.verifications, [])
    assert.equal(status.level, 'unverified')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('a verification does not cover an edit made after it', async () => {
  const root = project({ test: 'npm test' })
  try {
    const harness = mockContext()
    await cairn.apply(harness.ctx, { pheromonePersist: false })
    const agent = agentFor(root)
    observeWrite(harness, agent, join(root, 'a.rs'))
    await postExecute(harness, shellExec('npm test', agent), { content: [{ type: 'text', text: 'ok' }] })
    observeWrite(harness, agent, join(root, 'a.rs'), 'edit')
    const status = await harness.tool('cairn_status').execute({}, { agent })
    assert.equal(status.level, 'unverified', 'the check predates the edit')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

/* ------------------------------------------------------------------ *
 * Injection
 * ------------------------------------------------------------------ */

test('an unverified change injects one labelled notice', async () => {
  const root = project({ test: 'npm test', routes: [{ match: '**/*.rs', run: 'cargo test' }] })
  try {
    const harness = mockContext()
    await cairn.apply(harness.ctx, { pheromonePersist: false })
    const agent = agentFor(root)
    observeWrite(harness, agent, join(root, 'src', 'a.rs'))

    const decision = await postExecute(harness, readExec(agent), { content: [{ type: 'text', text: 'x' }] })
    assert.equal(decision.additionalContexts.length, 1)
    const [context] = decision.additionalContexts
    assert.equal(context.role, 'user')
    assert.equal(context.source.kind, 'cairn', 'an unlabelled context would render as a user prompt')
    assert.equal(context.source.form, 'notice')
    assert.ok(context.source.summary.length <= 120)
    assert.match(context.content[0].text, /^<cairn>/)
    assert.match(context.content[0].text, /no verification after their last write/)
    assert.ok(context.id.length > 0)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('the same notice is not injected twice in a row', async () => {
  const root = project()
  try {
    const harness = mockContext()
    await cairn.apply(harness.ctx, { pheromonePersist: false })
    const agent = agentFor(root)
    observeWrite(harness, agent, join(root, 'a.rs'))

    const first = await postExecute(harness, readExec(agent), {})
    const second = await postExecute(harness, readExec(agent), {})
    assert.equal(first.additionalContexts.length, 1)
    assert.equal(second.additionalContexts, undefined, 'repeating the same words trains the model to skim')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('a new user prompt reopens the notice, with a fresh id', async () => {
  const root = project()
  try {
    const harness = mockContext()
    await cairn.apply(harness.ctx, { pheromonePersist: false })
    const agent = agentFor(root)
    observeWrite(harness, agent, join(root, 'a.rs'))

    const first = await postExecute(harness, readExec(agent), {})
    await cairn.apply // keep the linter honest about top-level await ordering
    const [preStep] = harness.listeners.get('agent/pre-step')
    let nexted = false
    const returned = preStep({ agent, messages: [{ source: { kind: 'user' } }] }, () => { nexted = true; return 'next' })
    assert.equal(returned, 'next')
    assert.equal(nexted, true, 'pre-step must always continue the chain')

    const second = await postExecute(harness, readExec(agent), {})
    assert.equal(second.additionalContexts.length, 1)
    assert.notEqual(second.additionalContexts[0].id, first.additionalContexts[0].id, 'a repeated id collides in history')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('an injected notice keeps any context another plugin already queued', async () => {
  const root = project()
  try {
    const harness = mockContext()
    await cairn.apply(harness.ctx, { pheromonePersist: false })
    const agent = agentFor(root)
    observeWrite(harness, agent, join(root, 'a.rs'))
    const theirs = { id: 'theirs', role: 'user', content: [], source: { kind: 'other' } }
    const decision = await postExecute(harness, readExec(agent), {}, { kind: 'accept', additionalContexts: [theirs] })
    assert.equal(decision.additionalContexts.length, 2)
    assert.equal(decision.additionalContexts[1], theirs)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('a blocked decision keeps its kind and feedback', async () => {
  const root = project()
  try {
    const harness = mockContext()
    await cairn.apply(harness.ctx, { pheromonePersist: false })
    const agent = agentFor(root)
    observeWrite(harness, agent, join(root, 'a.rs'))
    const decision = await postExecute(harness, readExec(agent), {}, { kind: 'block', feedback: 'no' })
    assert.equal(decision.kind, 'block')
    assert.equal(decision.feedback, 'no')
    assert.equal(decision.additionalContexts.length, 1)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('a verified session injects nothing at all', async () => {
  const root = project({ test: 'npm test' })
  try {
    const harness = mockContext()
    await cairn.apply(harness.ctx, { pheromonePersist: false })
    const agent = agentFor(root)
    observeWrite(harness, agent, join(root, 'a.rs'))
    await postExecute(harness, shellExec('npm test', agent), { content: [{ type: 'text', text: 'ok' }] })
    const decision = await postExecute(harness, readExec(agent), {})
    assert.equal(decision.additionalContexts, undefined, 'a verified session must cost zero tokens')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('gate.mode off silences the notice but keeps the ledger', async () => {
  const root = project()
  try {
    const harness = mockContext()
    await cairn.apply(harness.ctx, { gateMode: 'off', pheromonePersist: false })
    const agent = agentFor(root)
    observeWrite(harness, agent, join(root, 'a.rs'))
    const decision = await postExecute(harness, readExec(agent), {})
    assert.equal(decision.additionalContexts, undefined)
    const status = await harness.tool('cairn_status').execute({}, { agent })
    assert.equal(status.level, 'unverified', 'the accounting must survive the mute')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('injectReadiness:false keeps the ledger and drops the notice', async () => {
  const root = project()
  try {
    const harness = mockContext()
    await cairn.apply(harness.ctx, { injectReadiness: false, pheromonePersist: false })
    const agent = agentFor(root)
    observeWrite(harness, agent, join(root, 'a.rs'))
    const decision = await postExecute(harness, readExec(agent), {})
    assert.equal(decision.additionalContexts, undefined)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

/* ------------------------------------------------------------------ *
 * The gate
 * ------------------------------------------------------------------ */

test('the gate is silent under the default reminder mode', async () => {
  const root = project()
  try {
    const harness = mockContext()
    await cairn.apply(harness.ctx, { pheromonePersist: false })
    const agent = agentFor(root)
    observeWrite(harness, agent, join(root, 'a.rs'))
    const [preExecute] = harness.listeners.get('tools/pre-execute')
    const returned = preExecute({ name: 'present', arguments: {}, agent }, () => ({ kind: 'allow' }))
    assert.deepEqual(returned, { kind: 'allow' })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('in deny mode the gate holds an unverified delivery claim', async () => {
  const root = project()
  try {
    const harness = mockContext()
    await cairn.apply(harness.ctx, { gateMode: 'deny', pheromonePersist: false })
    const agent = agentFor(root)
    observeWrite(harness, agent, join(root, 'a.rs'))
    const [preExecute] = harness.listeners.get('tools/pre-execute')
    const returned = preExecute({ name: 'present', arguments: {}, agent }, () => ({ kind: 'allow' }))
    assert.equal(returned.kind, 'deny')
    assert.match(returned.reason, /is a delivery claim, but unverified/)
    assert.match(returned.reason, /Run the declared check/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('in deny mode a verified session passes the gate', async () => {
  const root = project({ test: 'npm test' })
  try {
    const harness = mockContext()
    await cairn.apply(harness.ctx, { gateMode: 'deny', pheromonePersist: false })
    const agent = agentFor(root)
    observeWrite(harness, agent, join(root, 'a.rs'))
    await postExecute(harness, shellExec('npm test', agent), { content: [{ type: 'text', text: 'ok' }] })
    const [preExecute] = harness.listeners.get('tools/pre-execute')
    const returned = preExecute({ name: 'present', arguments: {}, agent }, () => ({ kind: 'allow' }))
    assert.equal(returned.kind, 'allow')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('in deny mode the gate also holds a gated shell command', async () => {
  const root = project()
  try {
    const harness = mockContext()
    await cairn.apply(harness.ctx, { gateMode: 'deny', pheromonePersist: false })
    const agent = agentFor(root)
    observeWrite(harness, agent, join(root, 'a.rs'))
    const [preExecute] = harness.listeners.get('tools/pre-execute')
    const gated = preExecute(shellExec('git commit -m "done"', agent), () => ({ kind: 'allow' }))
    assert.equal(gated.kind, 'deny')
    assert.match(gated.reason, /command "git commit"/)
    const harmless = preExecute(shellExec('git status', agent), () => ({ kind: 'allow' }))
    assert.equal(harmless.kind, 'allow', 'only the declared commands are held')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('in deny mode a blocked verification does not pass the gate', async () => {
  const root = project({ test: 'npm test' })
  try {
    const harness = mockContext()
    await cairn.apply(harness.ctx, { gateMode: 'deny', pheromonePersist: false })
    const agent = agentFor(root)
    observeWrite(harness, agent, join(root, 'a.rs'))
    await postExecute(harness, shellExec('npm test', agent), { isError: true, content: [{ type: 'text', text: 'no such file' }] })
    const [preExecute] = harness.listeners.get('tools/pre-execute')
    const returned = preExecute({ name: 'present', arguments: {}, agent }, () => ({ kind: 'allow' }))
    assert.equal(returned.kind, 'deny', '"the toolchain was missing" is not a pass')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('the gate never throws on a malformed execution', async () => {
  const harness = mockContext()
  await cairn.apply(harness.ctx, { gateMode: 'deny', pheromonePersist: false })
  const [preExecute] = harness.listeners.get('tools/pre-execute')
  assert.deepEqual(preExecute(undefined, () => ({ kind: 'allow' })), { kind: 'allow' })
  assert.deepEqual(preExecute({ name: 'present' }, () => ({ kind: 'allow' })), { kind: 'allow' })
})

/* ------------------------------------------------------------------ *
 * The tools
 * ------------------------------------------------------------------ */

test('cairn_routes reports declared checks without running them', async () => {
  const root = project({ test: 'npm test', routes: [{ match: 'src/**/*.rs', run: 'cargo test' }] })
  try {
    const harness = mockContext()
    await cairn.apply(harness.ctx, { pheromonePersist: false })
    const agent = agentFor(root)
    const result = await harness.tool('cairn_routes').execute({ files: ['src/a.rs'] }, { agent })
    assert.deepEqual(result.matched.map((r) => r.run), ['cargo test'])
    assert.match(result.hint, /cargo test/)
    assert.equal(result.error, '')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('cairn_routes falls back to the files this session changed', async () => {
  const root = project({ routes: [{ match: 'src/**', run: 'make check' }] })
  try {
    const harness = mockContext()
    await cairn.apply(harness.ctx, { pheromonePersist: false })
    const agent = agentFor(root)
    observeWrite(harness, agent, join(root, 'src', 'a.rs'))
    const result = await harness.tool('cairn_routes').execute({}, { agent })
    assert.deepEqual(result.matched.map((r) => r.match), ['src/**'])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('cairn_routes reports an unreadable config with its reason', async () => {
  const root = project('{ this is not json')
  try {
    const harness = mockContext()
    await cairn.apply(harness.ctx, { pheromonePersist: false })
    const agent = agentFor(root)
    const result = await harness.tool('cairn_routes').execute({}, { agent })
    assert.equal(result.declared, 'unreadable')
    assert.ok(result.error.length > 0, 'a broken config must say why it is broken')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('cairn_status carries the reason a config could not be read', async () => {
  const root = project('{ broken')
  try {
    const harness = mockContext()
    await cairn.apply(harness.ctx, { pheromonePersist: false })
    const agent = agentFor(root)
    const status = await harness.tool('cairn_status').execute({}, { agent })
    assert.match(status.declared, /^unreadable: .+/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('cairn_status verbose lists every tracked file', async () => {
  const root = project()
  try {
    const harness = mockContext()
    await cairn.apply(harness.ctx, { pheromonePersist: false })
    const agent = agentFor(root)
    for (let i = 0; i < 25; i += 1) observeWrite(harness, agent, join(root, `f${i}.rs`))
    const brief = await harness.tool('cairn_status').execute({}, { agent })
    const verbose = await harness.tool('cairn_status').execute({ verbose: true }, { agent })
    assert.equal(brief.files.length, 20)
    assert.equal(verbose.files.length, 25)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('cairn_signal deposits, lists, and forgets', async () => {
  const root = project()
  try {
    const harness = mockContext()
    await cairn.apply(harness.ctx, { pheromonePersist: false })
    const agent = agentFor(root)
    const tool = harness.tool('cairn_signal')

    const deposited = await tool.execute(
      { action: 'deposit', path: 'src/a.rs', signal: 'fragile', strength: 0.7, context: 'broke twice' },
      { agent }
    )
    assert.equal(deposited.changed, 1)
    assert.equal(deposited.entries[0].path, 'src/a.rs', 'the path is stored repo-relative')
    assert.equal(deposited.error, '')

    const listed = await tool.execute({ action: 'list' }, { agent })
    assert.equal(listed.entries.length, 1)
    assert.equal(listed.entries[0].context, 'broke twice')

    const forgotten = await tool.execute({ action: 'forget', path: 'src/a.rs', signal: 'fragile' }, { agent })
    assert.equal(forgotten.changed, 1)
    assert.equal((await tool.execute({ action: 'list' }, { agent })).entries.length, 0)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('cairn_signal reports a bad request instead of guessing', async () => {
  const root = project()
  try {
    const harness = mockContext()
    await cairn.apply(harness.ctx, { pheromonePersist: false })
    const agent = agentFor(root)
    const tool = harness.tool('cairn_signal')
    assert.match((await tool.execute({ action: 'deposit', path: 'a.rs' }, { agent })).error, /needs `path` and `signal`/)
    assert.match((await tool.execute({ action: 'deposit', path: 'a.rs', signal: 'nonsense' }, { agent })).error, /rejected/)
    assert.match((await tool.execute({ action: 'forget' }, { agent })).error, /needs `path`/)
    assert.deepEqual((await tool.execute({}, { agent })).action, 'list', 'the default action is list')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('cairn_signal says so when pheromones are switched off', async () => {
  const root = project()
  try {
    const harness = mockContext()
    await cairn.apply(harness.ctx, { pheromoneEnabled: false })
    const agent = agentFor(root)
    const result = await harness.tool('cairn_signal').execute({ action: 'list' }, { agent })
    assert.match(result.error, /pheromones are disabled/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

/* ------------------------------------------------------------------ *
 * Pheromones across sessions
 * ------------------------------------------------------------------ */

test('a signal deposited in one session is visible in the next', async () => {
  const root = project()
  const home = mkdtempSync(join(tmpdir(), 'cairn-home-'))
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = home
  try {
    const first = mockContext()
    await cairn.apply(first.ctx, {})
    const deposited = await first.tool('cairn_signal').execute(
      { action: 'deposit', path: 'src/a.rs', signal: 'fragile', strength: 0.9, context: 'broke twice' },
      { agent: agentFor(root) }
    )
    assert.equal(deposited.changed, 1)
    // The harness disposes the plugin on shutdown; that is what flushes.
    for (const setup of first.effects) setup()()

    const second = mockContext()
    await cairn.apply(second.ctx, {})
    const agent = agentFor(root)
    observeWrite(second, agent, join(root, 'src', 'a.rs'))
    const status = await second.tool('cairn_status').execute({}, { agent })
    assert.equal(status.signals.length, 1)
    assert.equal(status.signals[0].signal, 'fragile')
    assert.ok(status.signals[0].strength > 0.8)
    assert.equal(status.signals[0].context, 'broke twice')
    for (const setup of second.effects) setup()()
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
    rmSync(root, { recursive: true, force: true })
    rmSync(home, { recursive: true, force: true })
  }
})

test('a failing check deposits fragile on the file it covered', async () => {
  const root = project({ test: 'npm test' })
  try {
    const harness = mockContext()
    await cairn.apply(harness.ctx, { pheromonePersist: false })
    const agent = agentFor(root)
    observeWrite(harness, agent, join(root, 'src', 'a.rs'))
    await postExecute(harness, shellExec('npm test', agent), { content: [{ type: 'text', text: '[exit code: 1]' }] })
    const status = await harness.tool('cairn_status').execute({}, { agent })
    assert.deepEqual(status.signals.map((s) => s.signal), ['fragile'])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('repeated edits without a passing check deposit fragile', async () => {
  const root = project()
  try {
    const harness = mockContext()
    await cairn.apply(harness.ctx, { pheromonePersist: false, fragileWrites: 3 })
    const agent = agentFor(root)
    for (let i = 0; i < 3; i += 1) observeWrite(harness, agent, join(root, 'src', 'a.rs'), 'edit')
    await postExecute(harness, readExec(agent), {})
    const status = await harness.tool('cairn_status').execute({}, { agent })
    assert.ok(status.signals.some((s) => s.signal === 'fragile'))
    assert.match(status.signals.find((s) => s.signal === 'fragile').context, /edited 3 times/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('repeated reads deposit an entry-point marker', async () => {
  const root = project()
  try {
    const harness = mockContext()
    await cairn.apply(harness.ctx, { pheromonePersist: false, entryPointReads: 3 })
    const agent = agentFor(root)
    for (let i = 0; i < 3; i += 1) observeRead(harness, agent, join(root, 'src', 'main.rs'))
    await postExecute(harness, readExec(agent), {})
    // Read from the store directly: `cairn_status.signals` is scoped to files
    // this session *changed*, and a read creates no ownership.
    const listed = await harness.tool('cairn_signal').execute({ action: 'list' }, { agent })
    assert.deepEqual(listed.entries.map((e) => [e.path, e.signal]), [['src/main.rs', 'entry-point']])
    assert.match(listed.entries[0].context, /read 3 times/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('autoDeposit:false leaves the store empty', async () => {
  const root = project({ test: 'npm test' })
  try {
    const harness = mockContext()
    await cairn.apply(harness.ctx, { pheromonePersist: false, autoDeposit: false })
    const agent = agentFor(root)
    observeWrite(harness, agent, join(root, 'src', 'a.rs'))
    await postExecute(harness, shellExec('npm test', agent), { content: [{ type: 'text', text: '[exit code: 1]' }] })
    const status = await harness.tool('cairn_status').execute({}, { agent })
    assert.deepEqual(status.signals, [])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('auto-deposit does not inflate a signal on every step', async () => {
  const root = project()
  try {
    const harness = mockContext()
    await cairn.apply(harness.ctx, { pheromonePersist: false, entryPointReads: 3 })
    const agent = agentFor(root)
    for (let i = 0; i < 3; i += 1) observeRead(harness, agent, join(root, 'src', 'main.rs'))
    await postExecute(harness, readExec(agent), {})
    const first = (await harness.tool('cairn_signal').execute({ action: 'list' }, { agent })).entries[0]
    for (let i = 0; i < 5; i += 1) await postExecute(harness, readExec(agent), {})
    const again = (await harness.tool('cairn_signal').execute({ action: 'list' }, { agent })).entries[0]
    assert.equal(again.strength, first.strength, 'the same evidence must not reinforce itself')

    // New evidence still deposits: a fourth read is a new count.
    observeRead(harness, agent, join(root, 'src', 'main.rs'))
    await postExecute(harness, readExec(agent), {})
    const grown = (await harness.tool('cairn_signal').execute({ action: 'list' }, { agent })).entries[0]
    assert.ok(grown.strength > first.strength, 'new evidence must still reinforce')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('a pheromone is rendered into the notice for a changed file', async () => {
  const root = project()
  try {
    const harness = mockContext()
    await cairn.apply(harness.ctx, { pheromonePersist: false })
    const agent = agentFor(root)
    await harness.tool('cairn_signal').execute(
      { action: 'deposit', path: 'src/a.rs', signal: 'fragile', strength: 0.9, context: 'broke twice' },
      { agent }
    )
    observeWrite(harness, agent, join(root, 'src', 'a.rs'))
    const decision = await postExecute(harness, readExec(agent), {})
    const text = decision.additionalContexts[0].content[0].text
    assert.match(text, /Prior sessions left signals on files in play/)
    assert.match(text, /src\/a\.rs \[fragile 90%\] — broke twice/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

/* ------------------------------------------------------------------ *
 * ignore: what counts as a change this session made
 * ------------------------------------------------------------------ */

test('a scratch path the project ignores never enters the readiness list', async () => {
  // Measured on a real kernel session: 121 of 163 injected notices named a
  // throwaway script under a scratch directory, and the list only shows six
  // files — so the source actually under change was the part that got cut.
  const root = project({ test: 'cargo test', ignore: ['.rivet/**', 'target/**'] })
  const harness = mockContext()
  await cairn.apply(harness.ctx, {})
  const agent = agentFor(root)

  observeWrite(harness, agent, join(root, '.rivet', 'tools', 'probe_kernel_sie.py'))
  observeWrite(harness, agent, join(root, 'target', 'debug', 'kernel'))
  observeWrite(harness, agent, join(root, 'src', 'mm', 'memory_set.rs'))

  // `ls`, not the declared check: a passing `cargo test` would verify the file
  // and there would be nothing left to report.
  const decision = await postExecute(harness, shellExec('ls', agent), { content: [{ type: 'text', text: 'ok' }] })
  const [context] = decision.additionalContexts
  const body = context.content[0].text
  assert.match(body, /src\/mm\/memory_set\.rs/)
  assert.doesNotMatch(body, /\.rivet/)
  assert.doesNotMatch(body, /probe_kernel_sie/)
  assert.doesNotMatch(body, /target\/debug/)

  const status = await harness.tool('cairn_status').execute({}, { agent })
  const value = status.value ?? status
  assert.deepEqual(value.files.map((file) => file.path ?? file), ['src/mm/memory_set.rs'])
})

test('an ignored path does not hold the gate, and an unignored one still does', async () => {
  const root = project({ ignore: ['.rivet/**'] })
  const harness = mockContext()
  await cairn.apply(harness.ctx, { gateMode: 'deny' })
  const agent = agentFor(root)

  observeWrite(harness, agent, join(root, '.rivet', 'tools', 'one_test.sh'))
  const allowed = (await Promise.all(harness.fire('tools/pre-execute', {
    name: 'present',
    arguments: {},
    agent,
    callId: 'c1'
  }, async () => ({ kind: 'allow' }))))[0]
  assert.equal(allowed.kind, 'allow', 'scratch alone must not block a delivery claim')

  observeWrite(harness, agent, join(root, 'src', 'net.rs'))
  const denied = (await Promise.all(harness.fire('tools/pre-execute', {
    name: 'present',
    arguments: {},
    agent,
    callId: 'c2'
  }, async () => ({ kind: 'allow' }))))[0]
  assert.equal(denied.kind, 'deny')
  assert.match(denied.reason, /src\/net\.rs/)
})

test('a project that declares no ignore still counts every write', async () => {
  // The guard is a filter, not a default. Without a declaration, a scratch
  // write is indistinguishable from source and must still be reported.
  const root = project({ test: 'cargo test' })
  const harness = mockContext()
  await cairn.apply(harness.ctx, {})
  const agent = agentFor(root)
  observeWrite(harness, agent, join(root, '.rivet', 'tools', 'x.py'))

  const decision = await postExecute(harness, shellExec('ls', agent), { content: [{ type: 'text', text: 'ok' }] })
  assert.match(decision.additionalContexts[0].content[0].text, /\.rivet/)
})