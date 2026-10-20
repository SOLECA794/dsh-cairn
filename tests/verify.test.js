/**
 * `lib/verify.js` — reading the project's declaration of its own checks.
 *
 * The property under test is that a broken declaration degrades to "nothing is
 * declared" and never to a crash, a spawn, or a command the project did not
 * write. `commandSatisfies` carries the actual trust decision, so it gets the
 * adversarial cases.
 */

import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import {
  VERIFY_CONFIG_PATH,
  VERIFY_DEFAULTS,
  VERIFY_KINDS,
  classifyCommand,
  classifyRouteCommand,
  commandSatisfies,
  describeVerifyConfig,
  invalidateVerifyConfig,
  loadVerifyConfig,
  isIgnored,
  matchRoutes,
  parseVerifyConfig,
  renderVerifyHint
} from '../lib/verify.js'

function scratch() {
  const dir = mkdtempSync(join(tmpdir(), 'cairn-verify-'))
  return { dir, done: () => rmSync(dir, { recursive: true, force: true }) }
}

/** Write `.cairn/verify.json` under `root` and drop the memo. */
function declare(root, value) {
  mkdirSync(join(root, '.cairn'), { recursive: true })
  writeFileSync(join(root, VERIFY_CONFIG_PATH), JSON.stringify(value))
  invalidateVerifyConfig(root)
}

test('the config path is project-root only', () => {
  assert.equal(VERIFY_CONFIG_PATH, '.cairn/verify.json')
})

test('parseVerifyConfig accepts the documented shape', () => {
  const { ok, config } = parseVerifyConfig({
    test: 'cargo test',
    build: 'cargo build',
    typecheck: 'cargo check',
    lint: 'cargo clippy',
    routes: [{ match: 'src/**/*.rs', run: 'cargo check', note: 'rust sources' }]
  })
  assert.equal(ok, true)
  assert.equal(config.test, 'cargo test')
  assert.equal(config.build, 'cargo build')
  assert.deepEqual(config.routes, [{ match: 'src/**/*.rs', run: 'cargo check', note: 'rust sources' }])
})

test('parseVerifyConfig treats absent and null as "nothing declared"', () => {
  for (const raw of [undefined, null]) {
    const parsed = parseVerifyConfig(raw)
    assert.equal(parsed.ok, true)
    assert.deepEqual(parsed.config.routes, [])
    assert.equal(parsed.config.test, undefined)
  }
})

test('parseVerifyConfig rejects a non-object root', () => {
  for (const raw of [[], 'cargo test', 42, true]) {
    const parsed = parseVerifyConfig(raw)
    assert.equal(parsed.ok, false)
    assert.match(parsed.reason, /must be a JSON object/)
  }
})

test('parseVerifyConfig rejects multi-line commands (injection guard)', () => {
  const parsed = parseVerifyConfig({ test: 'cargo test\nrm -rf /' })
  assert.equal(parsed.ok, false)
  assert.match(parsed.reason, /single line/)
})

test('parseVerifyConfig rejects commands that are not strings or too long', () => {
  assert.equal(parseVerifyConfig({ test: 42 }).ok, false)
  const long = `cargo test ${'x'.repeat(VERIFY_DEFAULTS.maxCommandChars)}`
  const parsed = parseVerifyConfig({ test: long })
  assert.equal(parsed.ok, false)
  assert.match(parsed.reason, /longer than/)
})

test('parseVerifyConfig rejects an unrunnable route', () => {
  assert.equal(parseVerifyConfig({ routes: 'nope' }).ok, false)
  assert.equal(parseVerifyConfig({ routes: [null] }).ok, false)
  assert.equal(parseVerifyConfig({ routes: [{ run: 'x' }] }).ok, false, 'empty match')
  assert.equal(parseVerifyConfig({ routes: [{ match: 'a' }] }).ok, false, 'empty run')
  assert.equal(parseVerifyConfig({ routes: [{ match: '  ', run: 'x' }] }).ok, false)
})

test('parseVerifyConfig caps the route count', () => {
  const routes = Array.from({ length: VERIFY_DEFAULTS.maxRoutes + 1 }, (_, i) => ({
    match: `src/f${i}.rs`,
    run: 'cargo check'
  }))
  const parsed = parseVerifyConfig({ routes })
  assert.equal(parsed.ok, false)
  assert.match(parsed.reason, /cap is 64/)
})

test('parseVerifyConfig dedupes identical routes and clips the note', () => {
  const parsed = parseVerifyConfig({
    routes: [
      { match: 'src/*.rs', run: 'cargo check' },
      { match: 'src/*.rs', run: 'cargo check' }
    ]
  })
  assert.equal(parsed.ok, true)
  assert.equal(parsed.config.routes.length, 1, 'the same match+run is one route')

  // Two routes that differ only in `note` are still the same check.
  const noted = parseVerifyConfig({
    routes: [
      { match: 'src/*.rs', run: 'cargo check' },
      { match: 'src/*.rs', run: 'cargo check', note: 'n'.repeat(500) }
    ]
  })
  assert.equal(noted.config.routes.length, 1)
  assert.equal(noted.config.routes[0].note, undefined, 'the deduped entry keeps the first note')

  const clipped = parseVerifyConfig({
    routes: [{ match: 'src/*.rs', run: 'cargo check', note: 'n'.repeat(500) }]
  })
  assert.equal(clipped.config.routes[0].note.length, 200)
})

test('loadVerifyConfig returns an empty config when the file is absent', () => {
  const { dir, done } = scratch()
  try {
    const loaded = loadVerifyConfig(dir)
    assert.equal(loaded.ok, true)
    assert.equal(loaded.path, undefined)
    assert.deepEqual(loaded.config.routes, [])
  } finally {
    done()
  }
})

test('loadVerifyConfig reports an unreadable file instead of throwing', () => {
  const { dir, done } = scratch()
  try {
    mkdirSync(join(dir, '.cairn'), { recursive: true })
    writeFileSync(join(dir, VERIFY_CONFIG_PATH), '{ broken')
    invalidateVerifyConfig(dir)
    const loaded = loadVerifyConfig(dir)
    assert.equal(loaded.ok, false)
    assert.match(loaded.reason, /unreadable config/)
    assert.deepEqual(loaded.config.routes, [], 'a broken config still degrades to no routes')
  } finally {
    done()
  }
})

test('loadVerifyConfig memoises but notices an edit', () => {
  const { dir, done } = scratch()
  try {
    declare(dir, { test: 'make test' })
    assert.equal(loadVerifyConfig(dir).config.test, 'make test')
    // A stale memo would hide the project's own edit for the rest of the session.
    declare(dir, { test: 'make test-all' })
    assert.equal(loadVerifyConfig(dir).config.test, 'make test-all')
    // `fresh` bypasses the memo even with an untouched mtime.
    assert.equal(loadVerifyConfig(dir, { fresh: true }).config.test, 'make test-all')
  } finally {
    done()
  }
})

test('commandSatisfies accepts the declared command and its flag forms', () => {
  assert.equal(commandSatisfies('cargo test', 'cargo test'), true)
  assert.equal(commandSatisfies('cargo test', 'cargo test --all'), true)
  assert.equal(commandSatisfies('cargo test', 'cargo test -q'), true)
  assert.equal(commandSatisfies('cargo test', 'cargo test RUST_LOG=debug'), true)
  assert.equal(commandSatisfies('  cargo test  ', '  cargo test  '), true)
})

test('commandSatisfies refuses the direction that would open the gate on a lie', () => {
  // `make clean` must never satisfy a declared `make`: it deletes the build tree.
  assert.equal(commandSatisfies('make', 'make clean'), false)
  assert.equal(commandSatisfies('make', 'make -j8 clean'), true, 'a flag is still a flag form')
  // Substring matching would let cmake pose as make.
  assert.equal(commandSatisfies('make', 'cmake build'), false)
  assert.equal(commandSatisfies('cargo test', 'cargo testing'), false)
  assert.equal(commandSatisfies('cargo test', 'sudo cargo test'), false)
})

test('commandSatisfies rejects junk inputs', () => {
  assert.equal(commandSatisfies(undefined, 'cargo test'), false)
  assert.equal(commandSatisfies('cargo test', undefined), false)
  assert.equal(commandSatisfies('', ''), false)
  assert.equal(commandSatisfies('   ', '   '), false)
})

test('classifyCommand maps a command onto the declared kinds', () => {
  const config = parseVerifyConfig({
    test: 'cargo test',
    build: 'cargo build',
    typecheck: 'cargo check',
    lint: 'cargo clippy'
  }).config
  assert.equal(classifyCommand('cargo test --all', config), 'test')
  assert.equal(classifyCommand('cargo build', config), 'build')
  assert.equal(classifyCommand('cargo check', config), 'typecheck')
  assert.equal(classifyCommand('cargo clippy --fix', config), 'lint')
  assert.equal(classifyCommand('cargo run', config), undefined)
  assert.equal(classifyCommand('', config), undefined)
  assert.equal(classifyCommand(undefined, config), undefined)
})

test('classifyCommand uses priority order when two kinds overlap', () => {
  // `cargo test --no-run` satisfies both declarations (`test` by exact-prefix +
  // flag, `build` because it is `cargo test --no-run` with no remainder). The
  // first kind in VERIFY_KINDS wins, and that order is stable on purpose so the
  // same command always attributes to the same check.
  const config = parseVerifyConfig({ test: 'cargo test', build: 'cargo test --no-run' }).config
  assert.equal(classifyCommand('cargo test --no-run', config), 'test')
  assert.deepEqual(VERIFY_KINDS, ['test', 'build', 'typecheck', 'lint'])
})

test('classifyRouteCommand finds the route a command belongs to', () => {
  const config = parseVerifyConfig({
    routes: [{ match: 'src/**/*.rs', run: 'cargo check --all-targets' }]
  }).config
  assert.equal(classifyRouteCommand('cargo check --all-targets', config)?.run, 'cargo check --all-targets')
  assert.equal(classifyRouteCommand('cargo check', config), undefined, 'the truncated form is a different check')
})

test('matchRoutes matches root-relative POSIX paths', () => {
  const routes = [
    { match: 'src/**/*.rs', run: 'cargo check' },
    { match: 'docs/**/*.md', run: 'make docs' }
  ]
  assert.deepEqual(matchRoutes(['src/net/mod.rs'], routes), [routes[0]])
  assert.deepEqual(matchRoutes(['src/net/mod.rs', 'docs/a.md'], routes), routes)
  assert.deepEqual(matchRoutes(['README.md'], routes), [])
  assert.deepEqual(matchRoutes([], routes), [])
  assert.deepEqual(matchRoutes(['src/a.rs'], []), [])
  assert.deepEqual(matchRoutes(['src/a.rs'], undefined), [])
})

test('matchRoutes converts absolute paths under the root, drops those outside it', () => {
  const root = 'C:\\repo'
  const routes = [{ match: 'src/*.rs', run: 'cargo check' }]
  assert.deepEqual(matchRoutes(['C:\\repo\\src\\a.rs'], routes, { root }), routes)
  // A path outside the root must not be silently reinterpreted as relative.
  assert.deepEqual(matchRoutes(['C:\\other\\src\\a.rs'], routes, { root }), [])
})

test('matchRoutes dedupes the same route reached by two files', () => {
  const routes = [{ match: 'src/**', run: 'cargo check' }]
  assert.equal(matchRoutes(['src/a.rs', 'src/b.rs'], routes).length, 1)
})

test('describeVerifyConfig summarises what was declared', () => {
  assert.equal(describeVerifyConfig(undefined), 'none declared')
  assert.equal(describeVerifyConfig(parseVerifyConfig({}).config), 'none declared')
  assert.equal(describeVerifyConfig(parseVerifyConfig({ test: 'x' }).config), 'test')
  assert.equal(
    describeVerifyConfig(parseVerifyConfig({ test: 'x', build: 'y', routes: [{ match: 'a', run: 'b' }] }).config),
    'test/build + 1 route'
  )
  assert.equal(
    describeVerifyConfig(parseVerifyConfig({ routes: [{ match: 'a', run: 'b' }, { match: 'c', run: 'd' }] }).config),
    '2 routes'
  )
})

test('renderVerifyHint is empty when nothing is declared and bounded otherwise', () => {
  assert.equal(renderVerifyHint(parseVerifyConfig({}).config), '')
  assert.equal(renderVerifyHint(undefined), '')

  const routes = Array.from({ length: 12 }, (_, i) => ({ match: `src/f${i}.rs`, run: 'cargo check' }))
  const hint = renderVerifyHint(parseVerifyConfig({ test: 'cargo test', routes }).config)
  assert.ok(hint.startsWith('<project-checks>'))
  assert.ok(hint.endsWith('</project-checks>'))
  assert.match(hint, /- test: `cargo test`/)
  assert.match(hint, /… 4 more/)
  // The block is paid for on every request, so it must stay small.
  assert.ok(hint.length < 1200, `hint was ${hint.length} chars`)
})

/* ------------------------------------------------------------------ *
 * ignore: paths that are not part of the deliverable
 * ------------------------------------------------------------------ */

test('ignore accepts globs, dedupes them, and survives on its own', () => {
  const parsed = parseVerifyConfig({
    test: 'cargo test',
    ignore: ['.rivet/**', 'target/**', '.rivet/**']
  })
  assert.equal(parsed.ok, true)
  assert.deepEqual(parsed.config.ignore, ['.rivet/**', 'target/**'])

  const only = parseVerifyConfig({ ignore: ['scratch/**'] })
  assert.equal(only.ok, true)
  assert.deepEqual(only.config.ignore, ['scratch/**'])
  assert.equal(describeVerifyConfig(only.config), 'ignore x1')
})

test('ignore is empty, not undefined, when nothing declares it', () => {
  // Downstream code does `.length` on it; an undefined here is a crash in the
  // observation path, which is the hottest path in the plugin.
  assert.deepEqual(parseVerifyConfig({}).config.ignore, [])
  assert.deepEqual(parseVerifyConfig(undefined).config.ignore, [])
})

test('a broken ignore entry is a config error, not a silent skip', () => {
  // `null` is not a broken declaration — it is JSON's way of saying "not set",
  // and it is accepted as an empty list, exactly like `routes`.
  const asNull = parseVerifyConfig({ ignore: null })
  assert.equal(asNull.ok, true)
  assert.deepEqual(asNull.config.ignore, [])

  for (const bad of ['scratch/**', 42, {}, true]) {
    const parsed = parseVerifyConfig({ ignore: bad })
    assert.equal(parsed.ok, false, `ignore: ${JSON.stringify(bad)} should be rejected`)
    assert.match(parsed.reason, /ignore must be an array/)
  }
  for (const empty of ['', '   ', 42, ['nested']]) {
    const parsed = parseVerifyConfig({ ignore: [empty] })
    assert.equal(parsed.ok, false)
    assert.match(parsed.reason, /ignore\[0\] must be a non-empty glob/)
  }
  // Only `**, *, ?` are special; everything else is escaped, so a bracket is a
  // literal rather than an unterminated character class. That means the
  // "invalid glob" branch is reachable only through `globToRegExp`'s
  // non-string guard — pinned here so the behaviour is a decision, not a guess.
  const literal = parseVerifyConfig({ ignore: ['src/[unclosed'] })
  assert.equal(literal.ok, true)
  assert.equal(isIgnored('src/[unclosed', literal.config), true)
  assert.equal(isIgnored('src/u', literal.config), false)
})

test('ignore is capped like routes are', () => {
  const over = Array.from({ length: VERIFY_DEFAULTS.maxIgnore + 1 }, (_, i) => `skip${i}/**`)
  const parsed = parseVerifyConfig({ ignore: over })
  assert.equal(parsed.ok, false)
  assert.match(parsed.reason, /ignore has 65 entries; the cap is 64/)
})

test('a rejected config falls back to no ignore globs at all', () => {
  const parsed = parseVerifyConfig({ ignore: ['.rivet/**'], test: 'cargo\ntest' })
  assert.equal(parsed.ok, false)
  assert.deepEqual(parsed.config.ignore, [])
  assert.equal(isIgnored('.rivet/tools/probe.py', parsed.config), false)
})

test('isIgnored matches only what the globs claim', () => {
  const config = parseVerifyConfig({ ignore: ['.rivet/**', 'target/**'] }).config
  assert.equal(isIgnored('.rivet/tools/probe_kernel_sie.py', config), true)
  assert.equal(isIgnored('.rivet/meridian.db-wal', config), true)
  assert.equal(isIgnored('target/debug/kernel', config), true)
  // The globs are anchored: a nested name that merely contains ".rivet" is
  // source, and the whole point is that source still gets verified.
  assert.equal(isIgnored('kernel-project/src/.rivet.rs', config), false)
  assert.equal(isIgnored('kernel-project/src/mm/memory_set.rs', config), false)
  assert.equal(isIgnored('src/target/release/x', config), false)
})

test('isIgnored tolerates a config that declares nothing, or nothing at all', () => {
  assert.equal(isIgnored('a.rs', parseVerifyConfig({}).config), false)
  assert.equal(isIgnored('a.rs', undefined), false)
  assert.equal(isIgnored('a.rs', null), false)
  assert.equal(isIgnored('a.rs', { ignore: 'not-an-array' }), false)
  assert.equal(isIgnored('', parseVerifyConfig({ ignore: ['**'] }).config), false)
})

test('describeVerifyConfig reports the ignore count alongside the rest', () => {
  const config = parseVerifyConfig({
    test: 'cargo test',
    build: 'make build',
    routes: [{ match: 'src/kernel/**', run: 'make test-shell' }],
    ignore: ['.rivet/**', 'target/**']
  }).config
  assert.equal(describeVerifyConfig(config), 'test/build + 1 route + ignore x2')
})