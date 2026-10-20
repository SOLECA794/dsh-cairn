#!/usr/bin/env node
/**
 * Show what dsh-cairn would tell the model, without installing it.
 *
 * The plugin's whole output is one conditional block of text, so the honest way
 * to evaluate it is to read that block for your own project. This script builds
 * a mock context, feeds it a session — the files you say changed, then one
 * shell result — and prints the notice verbatim, plus the decision the gate
 * would make about delivering.
 *
 *   node scripts/dry-run.mjs --root ../my-project --files src/net.rs,src/dns.rs
 *   node scripts/dry-run.mjs --root . --files src/a.rs --command "cargo test" --exit 1
 *
 * Nothing is written outside `$DSH_HOME`, and nothing is executed: the shell
 * result is a string you pass in.
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { registerHooks } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const stubUrl = new URL('../tests/stubs/dsh-tools.mjs', import.meta.url).href
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === '@deepseek-ai/dsh-tools') {
      return { url: stubUrl, format: 'module', shortCircuit: true }
    }
    return nextResolve(specifier, context)
  }
})

function parseArgs(argv) {
  const out = { root: process.cwd(), files: [], command: '', exit: 0, verbose: false }
  for (let i = 2; i < argv.length; i += 1) {
    const a = argv[i]
    if (a === '--verbose') out.verbose = true
    else if (a.startsWith('--')) out[a.slice(2)] = argv[++i]
  }
  if (typeof out.files === 'string') out.files = out.files.split(',').map((f) => f.trim()).filter(Boolean)
  out.exit = Number(out.exit)
  return out
}

const args = parseArgs(process.argv)
const root = resolve(args.root)

/* Signals must not touch the real DSH home during a dry run. */
const scratch = mkdtempSync(join(tmpdir(), 'cairn-dry-run-'))
process.env.DSH_HOME = scratch

const cairn = await import('../lib/index.js')
const { loadVerifyConfig, describeVerifyConfig, matchRoutes, renderVerifyHint } = await import('../lib/verify.js')
const { formatReadinessLine } = await import('../lib/remind.js')

const listeners = new Map()
const tools = new Map()
const ctx = {
  logger: { warn: () => {}, info: () => {}, debug: () => {}, error: () => {} },
  on(event, handler) {
    listeners.set(event, [...(listeners.get(event) ?? []), handler])
    return () => {}
  },
  effect(setup) {
    ctx.disposers.push(setup)
    return () => {}
  },
  tools: { register: (tool) => tools.set(tool.name, tool) },
  disposers: []
}

await cairn.apply(ctx, { gateMode: 'deny' })

const agent = { id: 'dry-run', session: { header: { cwd: root } } }
const fire = (event, ...rest) => (listeners.get(event) ?? []).map((handler) => handler(...rest))

console.log(`root      ${root}`)
const loaded = loadVerifyConfig(root, { fresh: true })
console.log(`declared  ${loaded.ok ? describeVerifyConfig(loaded.config) : `unreadable: ${loaded.reason}`}`)
if (!loaded.ok) console.log(`config    ${loaded.path ?? '(unreadable)'}`)

const files = args.files.length > 0 ? args.files : []
if (files.length === 0) {
  console.log('\nNo --files given, so the session changed nothing: the plugin would stay silent.')
  rmSync(scratch, { recursive: true, force: true })
  process.exit(0)
}

for (const file of files) {
  fire('fs/observed', { path: join(root, file) }, { kind: 'present', version: 'dry-run' }, { name: 'write', agent })
}
console.log(`changed   ${files.join(', ')}`)

const routes = matchRoutes(files.map((f) => ({ path: f })), loaded.ok ? loaded.config.routes : [], { root })
if (routes.length > 0) {
  console.log('\nmatched routes (these are what the notice will name)')
  for (const route of routes) console.log(`  ${route.match} → ${route.run}`)
} else {
  // Not injected: this is the `cairn_routes` answer, printed because a file no
  // route claims is the case people get wrong. The notice itself never dumps
  // the whole declaration — it names only the routes that matched.
  const hint = renderVerifyHint(loaded.ok ? loaded.config : { routes: [] })
  if (hint) console.log(`\nno route claims these files; the project declares:\n${hint}`)
}

/* One shell result, as the harness would hand it to `tools/post-execute`. */
const command = args.command || 'true'
const text = args.exit === 0 ? 'ok' : `failed\n[exit code: ${args.exit}]`
const [postExecute] = listeners.get('tools/post-execute') ?? []
const decision = await postExecute(
  { name: 'pwsh', arguments: { command }, agent },
  { content: [{ type: 'text', text }] },
  async () => ({ kind: 'accept' })
)

console.log('\n--- what the model reads next step ---')
const injected = decision.additionalContexts ?? []
if (injected.length === 0) {
  console.log('(nothing — every changed file is verified)')
} else {
  console.log(injected[0].content[0].text)
  console.log(`\nsource    kind=${injected[0].source.kind} form=${injected[0].source.form} summary=${JSON.stringify(injected[0].source.summary)}`)
  console.log(`cost      ${injected[0].content[0].text.length} chars`)
}

const status = await tools.get('cairn_status').execute({ verbose: args.verbose }, { agent })
console.log('\n--- ledger ---')
console.log(formatReadinessLine({ level: status.level, files: status.files }))
console.log(`canDeliver ${status.canDeliver} — ${status.reason}`)

const [preExecute] = listeners.get('tools/pre-execute') ?? []
const gate = await preExecute({ name: 'present', arguments: {}, agent }, () => ({ kind: 'allow' }))
console.log(`gate       ${gate.kind}${gate.reason ? ` — ${gate.reason}` : ''}`)

for (const setup of ctx.disposers) setup()()
rmSync(scratch, { recursive: true, force: true })
