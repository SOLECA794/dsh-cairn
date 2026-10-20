#!/usr/bin/env node
/**
 * Drive `apply()` end to end without a DSH install.
 *
 * The unit suite tests each module through its exported surface. This script
 * tests the thing the suite structurally cannot: that the *wiring* survives a
 * real session — a project on disk, files written through the `fs/observed`
 * seam, shell results handed to `tools/post-execute`, the gate consulted from
 * `tools/pre-execute`, and signals that outlive the plugin instance through a
 * real `DSH_HOME`.
 *
 * It is deliberately a sequence, not a pile of independent assertions: each
 * check runs against the state the previous one left, which is how the harness
 * actually calls these seams. A step that fails is reported and the run
 * continues, so one broken link does not hide the rest.
 *
 * Run it with `npm run verify` (or `node scripts/verify-apply.mjs`).
 */

import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { registerHooks } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const stubUrl = new URL('../tests/stubs/dsh-tools.mjs', import.meta.url).href
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === '@deepseek-ai/dsh-tools') {
      return { url: stubUrl, format: 'module', shortCircuit: true }
    }
    return nextResolve(specifier, context)
  }
})

/* Keep the run hermetic: signal files would otherwise land in the real ~/.dsh. */
const scratch = mkdtempSync(join(tmpdir(), 'cairn-verify-'))
process.env.DSH_HOME = scratch

const cairn = await import('../lib/index.js')

const checks = []
async function check(label, fn) {
  try {
    await fn()
    checks.push({ label, ok: true })
  } catch (error) {
    checks.push({ label, ok: false, error })
  }
}

function mockContext() {
  const listeners = new Map()
  const registeredTools = []
  const effects = []
  const warnings = []
  return {
    logger: {
      warn: (message) => warnings.push(String(message)),
      info: () => {},
      debug: () => {},
      error: (message) => warnings.push(String(message))
    },
    on(event, handler) {
      const list = listeners.get(event) ?? []
      list.push(handler)
      listeners.set(event, list)
      return () => {}
    },
    effect(setup) {
      effects.push(setup)
      return () => {}
    },
    tools: {
      register(tool) {
        registeredTools.push(tool)
        return () => {}
      }
    },
    listeners,
    registeredTools,
    effects,
    warnings,
    fire: (event, ...args) => (listeners.get(event) ?? []).map((handler) => handler(...args)),
    tool: (toolName) => registeredTools.find((tool) => tool.name === toolName)
  }
}

/** The `tools/post-execute` seam. */
function postExecute(harness, exec, result, decision = { kind: 'accept' }) {
  const [handler] = harness.listeners.get('tools/post-execute')
  return handler(exec, result, async () => decision)
}

/** The `tools/pre-execute` seam. */
function preExecute(harness, exec) {
  const [handler] = harness.listeners.get('tools/pre-execute')
  return handler(exec, () => ({ kind: 'allow' }))
}

const textResult = (text) => ({ content: [{ type: 'text', text }] })
const okResult = () => textResult('all good')
const failResult = () => textResult('failed\n[exit code: 1]')

async function main() {
  /* ---- A real project with a real declaration --------------------------- */

  const root = join(scratch, 'project')
  mkdirSync(join(root, '.cairn'), { recursive: true })
  mkdirSync(join(root, 'src'), { recursive: true })
  writeFileSync(join(root, 'src', 'net.rs'), 'fn main() {}\n')
  writeFileSync(join(root, 'src', 'other.rs'), 'fn other() {}\n')
  writeFileSync(
    join(root, '.cairn', 'verify.json'),
    JSON.stringify(
      {
        test: 'npm test',
        build: 'make build',
        routes: [{ match: 'src/**/*.rs', run: 'cargo test', note: 'the Rust unit tests' }]
      },
      null,
      2
    )
  )

  const agent = { id: 'verify-agent', session: { header: { cwd: root } } }

  /* ---- Registration ----------------------------------------------------- */

  const harness = mockContext()
  await cairn.apply(harness, { gateMode: 'deny', fragileWrites: 2, entryPointReads: 2 })

  await check('apply registers the three tools', () => {    assert.deepEqual(harness.registeredTools.map((tool) => tool.name).sort(), [
      'cairn_routes',
      'cairn_signal',
      'cairn_status'
    ])
  })

  await check('apply subscribes to the four seams it needs', () => {
    assert.deepEqual(
      [...harness.listeners.keys()].sort(),
      ['agent/pre-step', 'fs/observed', 'tools/post-execute', 'tools/pre-execute']
    )
  })

  await check('the start-up line admits the cost', () => {
    assert.match(harness.warnings[0] ?? '', /spends tokens by design; it saves none/)
  })

  /* ---- A session: write, run the check, watch the gate ------------------ */

  await check('the project declaration is read from .cairn/verify.json', async () => {
    const result = await harness.tool('cairn_routes').execute({ files: ['src/net.rs'] }, { agent })
    assert.deepEqual(result.matched.map((route) => route.run), ['cargo test'])
    assert.equal(result.error, '')
  })

  await check('a session that changed nothing may deliver', async () => {
    const status = await harness.tool('cairn_status').execute({}, { agent })
    assert.equal(status.level, 'verified')
    assert.equal(status.canDeliver, true)
    assert.deepEqual(status.files, [])
  })

  harness.fire(
    'fs/observed',
    { path: join(root, 'src', 'net.rs') },
    { kind: 'present', version: 'v1' },
    { name: 'write', agent }
  )

  await check('a write makes the file owned and unverified', async () => {
    const status = await harness.tool('cairn_status').execute({}, { agent })
    assert.equal(status.level, 'unverified')
    assert.equal(status.canDeliver, false)
    assert.deepEqual(status.files.map((file) => file.path), ['src/net.rs'])
  })

  await check('the next shell result injects exactly one cairn notice', async () => {
    const decision = await postExecute(harness, { name: 'read', arguments: {}, agent }, okResult())
    assert.equal(decision.additionalContexts.length, 1)
    const [context] = decision.additionalContexts
    assert.equal(context.source.kind, 'cairn')
    assert.equal(context.source.form, 'notice')
    assert.match(context.content[0].text, /^<cairn>/)
    assert.match(context.content[0].text, /src\/net\.rs/)
    assert.match(context.content[0].text, /Declared checks for these paths/)
  })

  await check('the same notice is not injected a second time', async () => {
    const decision = await postExecute(harness, { name: 'read', arguments: {}, agent }, okResult())
    assert.equal(decision.additionalContexts, undefined)
  })

  await check('the gate holds a delivery claim while the file is unverified', async () => {
    const decision = preExecute(harness, { name: 'present', arguments: {}, agent })
    assert.equal(decision.kind, 'deny')
    assert.match(decision.reason, /is a delivery claim, but unverified/)
  })

  await check('a failing check is recorded and still blocks', async () => {
    await postExecute(harness, { name: 'pwsh', arguments: { command: 'npm test' }, agent }, failResult())
    const status = await harness.tool('cairn_status').execute({}, { agent })
    assert.equal(status.level, 'failed')
    assert.equal(status.verifications.at(-1).status, 'failed')
    assert.equal(preExecute(harness, { name: 'present', arguments: {}, agent }).kind, 'deny')
  })

  await check('the failing check leaves a fragile signal behind', async () => {
    const listed = await harness.tool('cairn_signal').execute({ action: 'list' }, { agent })
    assert.ok(
      listed.entries.some((entry) => entry.path === 'src/net.rs' && entry.signal === 'fragile'),
      `expected a fragile signal, got ${JSON.stringify(listed.entries)}`
    )
  })

  await check('a passing route check clears the file', async () => {
    await postExecute(harness, { name: 'pwsh', arguments: { command: 'cargo test --all-targets' }, agent }, okResult())
    const status = await harness.tool('cairn_status').execute({}, { agent })
    assert.equal(status.level, 'verified')
    assert.equal(status.canDeliver, true)
    // A route carries no `kind`; the command is the identity that matters.
    assert.equal(status.verifications.at(-1).command, 'cargo test --all-targets')
  })

  await check('the gate opens for a verified session', () => {
    assert.equal(preExecute(harness, { name: 'present', arguments: {}, agent }).kind, 'allow')
  })

  await check('an unrelated command never counts as a verification', async () => {
    await postExecute(harness, { name: 'pwsh', arguments: { command: 'ls -la' }, agent }, okResult())
    const status = await harness.tool('cairn_status').execute({}, { agent })
    assert.equal(status.verifications.length, 2, 'only the two declared checks were recorded')
  })

  await check('an edit after the check reopens the file', async () => {
    harness.fire(
      'fs/observed',
      { path: join(root, 'src', 'net.rs') },
      { kind: 'present', version: 'v2' },
      { name: 'edit', agent }
    )
    const status = await harness.tool('cairn_status').execute({}, { agent })
    assert.equal(status.level, 'unverified', 'a check that predates the edit proves nothing about it')
    assert.equal(preExecute(harness, { name: 'present', arguments: {}, agent }).kind, 'deny')
  })

  await check('the gate holds a gated git command too', () => {
    const held = preExecute(harness, { name: 'pwsh', arguments: { command: 'git commit -m "done"' }, agent })
    assert.equal(held.kind, 'deny')
    assert.match(held.reason, /command "git commit"/)
  })

  await check('a new user prompt makes the notice admissible again', async () => {
    const [preStep] = harness.listeners.get('agent/pre-step')
    let continued = false
    preStep({ agent, messages: [{ source: { kind: 'user' } }] }, () => {
      continued = true
      return 'next'
    })
    assert.equal(continued, true, 'pre-step must always continue the chain')
    const decision = await postExecute(harness, { name: 'read', arguments: {}, agent }, okResult())
    assert.equal(decision.additionalContexts.length, 1)
  })

  await check('a malformed execution never throws through the gate', () => {
    assert.equal(preExecute(harness, undefined).kind, 'allow')
    assert.equal(preExecute(harness, { name: 'present' }).kind, 'allow')
  })

  /* ---- Persistence across a restart ------------------------------------- */

  await check('the disposer flushes signals to disk', async () => {
    await harness.tool('cairn_signal').execute(
      { action: 'deposit', path: 'src/other.rs', signal: 'coupling-hub', strength: 0.9, context: 'seven callers' },
      { agent }
    )
    for (const setup of harness.effects) setup()()
    const file = cairn.pheromonePathFor(root, scratch)
    assert.equal(existsSync(file), true, `expected a signal file at ${file}`)
    const saved = JSON.parse(readFileSync(file, 'utf8'))
    assert.ok(saved.entries.some((entry) => entry.path === 'src/other.rs'))
  })

  await check('a fresh instance sees the previous session\'s signals', async () => {
    const second = mockContext()
    await cairn.apply(second, {})
    // Read through the store: `cairn_status.signals` is scoped to files *this*
    // session changed, and a fresh session has changed nothing.
    const listed = await second.tool('cairn_signal').execute({ action: 'list' }, { agent })
    assert.ok(
      listed.entries.some((entry) => entry.path === 'src/other.rs' && entry.signal === 'coupling-hub'),
      `expected the inherited signal, got ${JSON.stringify(listed.entries)}`
    )
    for (const setup of second.effects) setup()()
  })

  await check('a second project does not share the first one\'s signals', () => {
    const other = join(scratch, 'other-project')
    mkdirSync(other, { recursive: true })
    assert.notEqual(cairn.pheromonePathFor(root, scratch), cairn.pheromonePathFor(other, scratch))
  })

  /* ---- Configuration, from the shapes a YAML row produces --------------- */

  await check('gateMode off mutes the notice but keeps the ledger', async () => {
    const quiet = mockContext()
    await cairn.apply(quiet, { gateMode: 'off' })
    quiet.fire(
      'fs/observed',
      { path: join(root, 'src', 'other.rs') },
      { kind: 'present', version: 'v1' },
      { name: 'write', agent }
    )
    const decision = await postExecute(quiet, { name: 'read', arguments: {}, agent }, okResult())
    assert.equal(decision.additionalContexts, undefined)
    const status = await quiet.tool('cairn_status').execute({}, { agent })
    assert.equal(status.level, 'unverified')
    for (const setup of quiet.effects) setup()()
  })

  await check('a broken config is reported as unreadable, with a reason', async () => {
    const broken = join(scratch, 'broken')
    mkdirSync(join(broken, '.cairn'), { recursive: true })
    writeFileSync(join(broken, '.cairn', 'verify.json'), '{ not json')
    const context = mockContext()
    await cairn.apply(context, {})
    const brokenAgent = { id: 'broken', session: { header: { cwd: broken } } }
    const status = await context.tool('cairn_status').execute({}, { agent: brokenAgent })
    assert.match(status.declared, /^unreadable: .+/)
    for (const setup of context.effects) setup()()
  })

  await check('enabled false wires nothing at all', async () => {
    const off = mockContext()
    await cairn.apply(off, { enabled: false })
    assert.equal(off.registeredTools.length, 0)
    assert.equal(off.listeners.size, 0)
    assert.match(off.warnings[0], /disabled by config/)
  })

  /* ---- Report ----------------------------------------------------------- */

  let failed = 0
  for (const entry of checks) {
    if (entry.ok) {
      console.log(`  ok   ${entry.label}`)
    } else {
      failed += 1
      console.log(`  FAIL ${entry.label}`)
      console.log(`       ${entry.error?.message ?? entry.error}`)
    }
  }
  console.log(`\n${checks.length - failed}/${checks.length} checks passed`)
  return failed
}

main()
  .then((failed) => {
    rmSync(scratch, { recursive: true, force: true })
    process.exit(failed === 0 ? 0 : 1)
  })
  .catch((error) => {
    rmSync(scratch, { recursive: true, force: true })
    console.error(error)
    process.exit(1)
  })
