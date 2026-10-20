/**
 * Replay a real session log through dsh-cairn and report what it would have said.
 *
 * The unit tests prove the algebra; `dry-run.mjs` proves the wiring. Neither
 * answers the question that decides whether this plugin is worth loading: in a
 * real session, how many notices would it inject, how many characters do they
 * cost, and how often would the gate have stopped a delivery claim?
 *
 * Installing the plugin needs a DSH restart, so this replays the recorded events
 * of a session instead: `fs/observed` is not in the log, so a read/write/edit
 * call is replayed as the observation it produced, and each shell result is fed
 * to the real `tools/post-execute` listener through a mock context.
 *
 * Usage: node scripts/replay-cairn.mjs <session.v4.jsonl.zstd> [--gate remind|deny]
 *                                      [--limit N] [--cwd DIR] [--verbose]
 */

import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { registerHooks } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import zlib from 'node:zlib'

const stubUrl = new URL('../tests/stubs/dsh-tools.mjs', import.meta.url).href
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === '@deepseek-ai/dsh-tools') return { url: stubUrl, shortCircuit: true }
    return nextResolve(specifier, context)
  }
})

const scratch = mkdtempSync(join(tmpdir(), 'cairn-replay-'))
process.env.DSH_HOME = scratch

const argv = process.argv.slice(2)
const file = argv.find((arg) => !arg.startsWith('--'))
if (file === undefined) {
  console.error('usage: node scripts/replay-cairn.mjs <session.v4.jsonl.zstd> [--gate remind|deny] [--limit N]')
  process.exit(2)
}
const flag = (name, fallback) => {
  const at = argv.indexOf(`--${name}`)
  return at >= 0 && argv[at + 1] !== undefined ? argv[at + 1] : fallback
}
const gateMode = flag('gate', 'remind')
const limit = Number(flag('limit', Infinity))
const verbose = argv.includes('--verbose')

/* ---------------------------- the session log ---------------------------- */

const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

/**
 * A dsh session log is a sequence of independent zstd frames; decompressing the
 * whole file stops after the first one (204 bytes of a 6 MB log).
 */
function readFrames(path) {
  const buf = readFileSync(path)
  const offsets = []
  for (let at = buf.indexOf(MAGIC, 0); at >= 0; at = buf.indexOf(MAGIC, at + 4)) offsets.push(at)
  const parts = []
  let failed = 0
  for (let index = 0; index < offsets.length; index += 1) {
    const end = index + 1 < offsets.length ? offsets[index + 1] : buf.length
    try {
      parts.push(zlib.zstdDecompressSync(buf.subarray(offsets[index], end)))
    } catch {
      failed += 1
    }
  }
  return { text: Buffer.concat(parts).toString('utf8'), frames: offsets.length, failed }
}

const { text, frames, failed } = readFrames(file)
const events = []
for (const line of text.split('\n')) {
  if (line.length === 0) continue
  try {
    events.push(JSON.parse(line))
  } catch {}
}
events.sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0))

const session = events.find((event) => event.type === 'session')
// The session event keeps `id`/`cwd` at the top level, not under `data`.
const sessionId = session?.id ?? session?.data?.id ?? '?'
const cwd = flag('cwd', session?.cwd ?? session?.data?.cwd ?? process.cwd())
console.log(`session ${sessionId} · cwd ${cwd}`)
console.log(`frames ${frames} (${failed} unreadable) · ${events.length} events · gate ${gateMode}`)

/* ------------------------------- mock ctx -------------------------------- */

function mockContext() {
  const listeners = new Map()
  const registeredTools = []
  const warnings = []
  const ctx = {
    logger: {
      warn: (message) => warnings.push(String(message)),
      info: () => {},
      debug: () => {},
      error: (message) => warnings.push(String(message))
    },
    on(event, handler) {
      if (!listeners.has(event)) listeners.set(event, [])
      listeners.get(event).push(handler)
    },
    effect(setup) {
      ctx.effects.push(typeof setup === 'function' ? setup() : undefined)
    },
    effects: [],
    tools: { register: (tool) => registeredTools.push(tool) }
  }
  return { ctx, listeners, registeredTools, warnings }
}

const { apply } = await import('../lib/index.js')
const mock = mockContext()
const started = Date.now()
await apply(mock.ctx, { gateMode })
console.log(`registered tools: ${mock.registeredTools.map((tool) => tool.name).join(', ')}`)
console.log(`listeners: ${[...mock.listeners].map(([event, list]) => `${event}x${list.length}`).join(' · ')}`)

const emitFs = async (target, observation, actor) => {
  for (const handler of mock.listeners.get('fs/observed') ?? []) await handler(target, observation, actor)
}
const postExecute = async (exec, result) => {
  const handler = (mock.listeners.get('tools/post-execute') ?? [])[0]
  if (handler === undefined) return undefined
  return handler(exec, result, async () => ({ kind: 'accept' }))
}
const preExecute = async (exec) => {
  const handler = (mock.listeners.get('tools/pre-execute') ?? [])[0]
  if (handler === undefined) return undefined
  return handler(exec, async () => ({ kind: 'accept' }))
}
const preStep = async (messages) => {
  for (const handler of mock.listeners.get('agent/pre-step') ?? []) {
    await handler({ agent, messages }, async () => ({ kind: 'accept' }))
  }
}

const agent = { id: 'replay', session: { header: { cwd } } }

/* ------------------------------ the replay ------------------------------- */

const READ_TOOLS = new Set(['read'])
const MUTATION_TOOLS = new Set(['write', 'edit'])
const SHELL_TOOLS = new Set(['pwsh', 'bash', 'shell', 'run_shell'])

const calls = new Map()
const counts = { calls: 0, observed: 0, shell: 0, notices: 0, noticeChars: 0, denied: 0, verifications: 0, scratchMentions: 0 }
const scratchSignals = { lines: 0, scratch: 0 }
const noticeShapes = new Map()
const prompts = new Map()
const denyReasons = []
const byTool = new Map()
let inspected = 0

const parseArgs = (raw) => {
  if (typeof raw !== 'string') return raw ?? {}
  try {
    return JSON.parse(raw)
  } catch {
    return {}
  }
}

for (const event of events) {
  if (inspected >= limit) break
  const data = event.data ?? {}

  if (event.type === 'user/message') {
    const kind = data.source?.kind ?? '?'
    prompts.set(kind, (prompts.get(kind) ?? 0) + 1)
    await preStep([{ role: 'user', source: data.source ?? { kind: 'user' } }])
    continue
  }

  if (event.type === 'tool/call') {
    inspected += 1
    counts.calls += 1
    byTool.set(data.name, (byTool.get(data.name) ?? 0) + 1)
    calls.set(data.callId, { name: data.name, arguments: data.arguments })

    const args = parseArgs(data.arguments)
    const path = args.file_path ?? args.path
    if (typeof path === 'string' && (READ_TOOLS.has(data.name) || MUTATION_TOOLS.has(data.name))) {
      counts.observed += 1
      await emitFs(
        { path, displayPath: path },
        { kind: 'present', version: 1 },
        { name: data.name, arguments: args, agent, callId: data.callId }
      )
    }

    // The gate is a pre-execute decision, so it is decided before the call runs.
    if (gateMode === 'deny') {
      const decision = await preExecute({ name: data.name, arguments: args, agent, callId: data.callId })
      if (decision?.kind === 'deny') {
        counts.denied += 1
        if (denyReasons.length < 6) denyReasons.push(decision.reason)
      }
    }
    continue
  }

  if (event.type === 'tool/result') {
    const call = calls.get(data.toolCallId ?? data.message?.toolCallId)
    if (call === undefined) continue
    if (!SHELL_TOOLS.has(call.name)) continue
    counts.shell += 1
    const args = parseArgs(call.arguments)
    const result = {
      isError: data.isError === true || data.message?.isError === true,
      content: data.message?.content ?? []
    }
    const decision = await postExecute(
      { name: call.name, arguments: args, agent, callId: data.toolCallId },
      result
    )
    for (const context of decision?.additionalContexts ?? []) {
      const text = context.content?.[0]?.text ?? ''
      counts.notices += 1
      counts.noticeChars += text.length
      if (text.includes('.rivet/')) counts.scratchMentions += 1
      for (const line of text.split('\n')) {
        if (!line.startsWith('- ') || !line.includes('[')) continue
        scratchSignals.lines += 1
        if (line.includes('.rivet/')) scratchSignals.scratch += 1
      }
      const shape = text.split('\n').slice(1).join(' ').slice(0, 100)
      noticeShapes.set(shape, (noticeShapes.get(shape) ?? 0) + 1)
      if (verbose) console.log(`\n--- notice after ${call.name} (${text.length} chars) ---\n${text}`)
    }
  }
}

/* ------------------------------- the verdict ----------------------------- */

const statusTool = mock.registeredTools.find((tool) => tool.name === 'cairn_status')
let snapshot
if (statusTool !== undefined) {
  snapshot = await statusTool.execute({ verbose: false }, { agent })
}
const bucket = new Map()
for (const file of (snapshot ?? {}).files ?? []) {
  const segment = String(file.path).split('/').slice(0, 2).join('/')
  bucket.set(segment, (bucket.get(segment) ?? 0) + 1)
}

const mean = counts.notices === 0 ? 0 : Math.round(counts.noticeChars / counts.notices)
console.log('\n================ replay report ================')
console.log(`tool calls                ${counts.calls}  (${counts.observed} file observations, ${counts.shell} shell results)`)
console.log(`notices injected          ${counts.notices}  (${counts.noticeChars} chars, mean ${mean})`)
console.log(`delivery claims denied    ${counts.denied}`)
console.log(`notices naming .rivet/    ${counts.scratchMentions} of ${counts.notices}`)
console.log(`signal lines from .rivet  ${scratchSignals.scratch} of ${scratchSignals.lines}`)
console.log(`elapsed                   ${((Date.now() - started) / 1000).toFixed(1)}s`)
if (bucket.size > 0) {
  console.log('\nchanged files by top-level area:')
  for (const [area, count] of [...bucket].sort((a, b) => b[1] - a[1])) console.log(`  ${String(count).padStart(5)}  ${area}`)
}
console.log('\ntool calls by name:')
for (const [name, count] of [...byTool].sort((a, b) => b[1] - a[1])) console.log(`  ${String(count).padStart(5)}  ${name}`)
console.log('\nuser messages by source.kind:')
for (const [kind, count] of [...prompts].sort((a, b) => b[1] - a[1])) console.log(`  ${String(count).padStart(5)}  ${kind}`)
console.log('\ndistinct notice openings:')
for (const [shape, count] of [...noticeShapes].sort((a, b) => b[1] - a[1])) {
  console.log(`  x${String(count).padStart(3)}  ${shape.slice(0, 110)}`)
}
if (denyReasons.length > 0) {
  console.log('\nfirst refusals:')
  for (const reason of denyReasons) console.log(`  - ${reason}`)
}
if (snapshot !== undefined) {
  const value = snapshot?.value ?? snapshot
  console.log('\ncairn_status:')
  console.log(JSON.stringify(value, null, 2).split('\n').map((line) => `  ${line}`).join('\n').slice(0, 2400))
}

rmSync(scratch, { recursive: true, force: true })
