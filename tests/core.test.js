/**
 * `lib/core.js` — the primitives everything else stands on.
 *
 * The two that matter most are `globToRegExp` (a route that silently fails to
 * match looks exactly like "this project does not care about that path") and
 * `toRootRelative` (a path that escapes the root must never be attributed to a
 * file inside it).
 */

import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import {
  clampInt,
  escapeTagBody,
  estimateTokens,
  findAncestorWith,
  formatCount,
  globToRegExp,
  hashShort,
  isAbsolutePath,
  isGlobMatch,
  nowIso,
  readJsonSafe,
  stableId,
  toPosix,
  toRootRelative,
  writeJsonAtomic
} from '../lib/core.js'

function scratch() {
  const dir = mkdtempSync(join(tmpdir(), 'cairn-core-'))
  return { dir, done: () => rmSync(dir, { recursive: true, force: true }) }
}

test('hashShort is stable, truncated, and input-sensitive', () => {
  assert.equal(hashShort('abc'), hashShort('abc'))
  assert.equal(hashShort('abc').length, 16)
  assert.equal(hashShort('abc', 8).length, 8)
  assert.notEqual(hashShort('abc'), hashShort('abd'))
})

test('stableId joins parts with a separator that cannot collide', () => {
  assert.equal(stableId('x', 'a', 'b'), stableId('x', 'a', 'b'))
  // Without the NUL separator `('ab','c')` and `('a','bc')` would be equal.
  assert.notEqual(stableId('x', 'ab', 'c'), stableId('x', 'a', 'bc'))
  assert.ok(stableId('x', 'a').startsWith('x:'))
})

test('toPosix normalises both separator styles', () => {
  assert.equal(toPosix('a\\b/c'), 'a/b/c')
  assert.equal(toPosix('C:\\x\\y.rs'), 'C:/x/y.rs')
})

test('isAbsolutePath recognises POSIX, UNC, and drive paths', () => {
  assert.equal(isAbsolutePath('/usr/lib'), true)
  assert.equal(isAbsolutePath('\\\\server\\share'), true)
  assert.equal(isAbsolutePath('C:\\x'), true)
  assert.equal(isAbsolutePath('c:/x'), true)
  assert.equal(isAbsolutePath('src/main.rs'), false)
  assert.equal(isAbsolutePath(''), false)
  assert.equal(isAbsolutePath(undefined), false)
})

test('toRootRelative rejects escapes and the root itself', () => {
  const root = 'C:\\work\\repo'
  assert.equal(toRootRelative(root, 'C:\\work\\repo\\src\\a.rs'), 'src/a.rs')
  assert.equal(toRootRelative(root, 'C:\\work\\repo'), null)
  assert.equal(toRootRelative(root, 'C:\\work\\other\\a.rs'), null)
  assert.equal(toRootRelative(root, ''), null)
  assert.equal(toRootRelative(undefined, 'a'), null)
})

test('globToRegExp: ** spans segments, * stays inside one', () => {
  const re = globToRegExp('src/**/*.rs')
  assert.equal(re.test('src/main.rs'), true, '**/ must also match zero directories')
  assert.equal(re.test('src/net/mod.rs'), true)
  assert.equal(re.test('lib/main.rs'), false)
  assert.equal(re.test('src/main.ts'), false)

  assert.equal(isGlobMatch('*.rs', 'main.rs'), true)
  assert.equal(isGlobMatch('*.rs', 'src/main.rs'), false, '* must not cross a separator')
  assert.equal(isGlobMatch('src/*', 'src/a/b.rs'), false)
})

test('globToRegExp escapes regex metacharacters in the glob', () => {
  // A `.` in a glob is a literal dot, not "any character".
  assert.equal(isGlobMatch('a.rs', 'axrs'), false)
  assert.equal(isGlobMatch('a+b.rs', 'a+b.rs'), true)
  assert.equal(isGlobMatch('(x).rs', '(x).rs'), true)
})

test('globToRegExp: ? matches exactly one non-separator character', () => {
  assert.equal(isGlobMatch('a?c', 'abc'), true)
  assert.equal(isGlobMatch('a?c', 'ac'), false)
  assert.equal(isGlobMatch('a?c', 'a/c'), false)
})

test('isGlobMatch never throws on a malformed pattern', () => {
  assert.equal(isGlobMatch('', 'a'), false)
  assert.equal(isGlobMatch(null, 'a'), false)
})

test('estimateTokens counts CJK denser than Latin and never returns 0 for text', () => {
  assert.equal(estimateTokens(''), 0)
  assert.equal(estimateTokens(undefined), 0)
  const latin = estimateTokens('abcdefgh')
  const cjk = estimateTokens('中文中文中文中文')
  assert.ok(cjk > latin, `${cjk} should exceed ${latin}`)
})

test('formatCount compacts thousands and millions', () => {
  assert.equal(formatCount(999), '999')
  assert.equal(formatCount(1234), '1.2K')
  assert.equal(formatCount(2_500_000), '2.5M')
  assert.equal(formatCount(undefined), '0')
})

test('clampInt truncates, clamps, and falls back on junk', () => {
  assert.equal(clampInt(5, 1, 10), 5)
  assert.equal(clampInt(0, 1, 10), 1)
  assert.equal(clampInt(99, 1, 10), 10)
  assert.equal(clampInt(3.9, 1, 10), 3)
  assert.equal(clampInt(NaN, 2, 10), 2)
  // Numeric strings are *not* coerced: this helper is for numbers already
  // validated at the config boundary, so a stray "7" is a bug upstream and the
  // floor is the safe answer.
  assert.equal(clampInt('7', 1, 10), 1)
  assert.equal(clampInt('x', 1, 10, 4), 4)
})

test('readJsonSafe returns undefined instead of throwing', () => {
  const { dir, done } = scratch()
  try {
    assert.equal(readJsonSafe(join(dir, 'missing.json')), undefined)
    writeFileSync(join(dir, 'bad.json'), '{ not json')
    assert.equal(readJsonSafe(join(dir, 'bad.json')), undefined)
    writeFileSync(join(dir, 'ok.json'), '{"a":1}')
    assert.deepEqual(readJsonSafe(join(dir, 'ok.json')), { a: 1 })
  } finally {
    done()
  }
})

test('writeJsonAtomic creates parents and lands the document', () => {
  const { dir, done } = scratch()
  try {
    const file = join(dir, 'deep', 'er', 'state.json')
    assert.equal(writeJsonAtomic(file, { v: 1 }), true)
    assert.deepEqual(readJsonSafe(file), { v: 1 })
    // A second write replaces rather than appends, and leaves no temp file.
    assert.equal(writeJsonAtomic(file, { v: 2 }, { indent: 2 }), true)
    assert.deepEqual(readJsonSafe(file), { v: 2 })
    assert.deepEqual(readdirSync(join(dir, 'deep', 'er')), ['state.json'])
  } finally {
    done()
  }
})

test('escapeTagBody neutralises the closing tag but nothing else', () => {
  assert.equal(escapeTagBody('a</cairn>b', 'cairn'), 'a<\\/cairn>b')
  assert.equal(escapeTagBody('a</other>b', 'cairn'), 'a</other>b')
  assert.equal(escapeTagBody('x</cairn>y</cairn>z', 'cairn'), 'x<\\/cairn>y<\\/cairn>z')
})

test('findAncestorWith walks up to the nearest marker', () => {
  const { dir, done } = scratch()
  try {
    mkdirSync(join(dir, 'repo', 'src', 'deep'), { recursive: true })
    writeFileSync(join(dir, 'repo', 'marker.txt'), 'x')
    assert.equal(
      findAncestorWith(join(dir, 'repo', 'src', 'deep'), ['marker.txt']),
      join(dir, 'repo')
    )
    assert.equal(findAncestorWith(join(dir, 'repo', 'src'), ['nope.txt']), null)
    assert.equal(findAncestorWith('', ['marker.txt']), null)
    // maxDepth 0 checks only the start directory.
    assert.equal(
      findAncestorWith(join(dir, 'repo', 'src'), ['marker.txt'], { maxDepth: 0 }),
      null
    )
  } finally {
    done()
  }
})

test('nowIso is ISO 8601 for the given instant', () => {
  assert.equal(nowIso(0), '1970-01-01T00:00:00.000Z')
  assert.match(nowIso(), /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
})
