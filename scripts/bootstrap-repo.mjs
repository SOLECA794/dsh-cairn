#!/usr/bin/env node
/**
 * Create a GitHub repository and upload a branch through the REST API.
 *
 * `git push` cannot work here: on this network `github.com:443` resets while
 * `api.github.com:443` answers. `push-via-api.mjs` covers the incremental case,
 * but it needs the remote branch to already exist and to point at a commit it
 * can diff against — neither is true the first time. This script does the
 * bootstrap: create the repo (idempotently), upload every file in the working
 * tree as a blob, build one parentless commit, and point `refs/heads/<branch>`
 * at it.
 *
 * Afterwards the local branch is one commit behind (the API minted the sha, not
 * git), so run `adopt-remote-commit.mjs --sha <printed sha>` to rebuild the
 * object locally and move the branch onto it.
 *
 *   GITHUB_TOKEN=... node scripts/bootstrap-repo.mjs \
 *       --repo SOLECA794/dsh-cairn --branch main --description "..."
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const API = 'https://api.github.com';

function parseArgs(argv) {
  const out = { repo: null, branch: 'main', description: '', private: false, dryRun: false };
  for (let i = 2; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--dry-run') out.dryRun = true;
    else if (a === '--private') out.private = true;
    else if (a.startsWith('--')) out[a.slice(2)] = argv[++i];
  }
  if (!out.repo) throw new Error('--repo owner/name is required');
  return out;
}

function git(args) {
  return execFileSync('git', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).trim();
}

async function call(token, method, path, body) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      accept: 'application/vnd.github+json',
      'content-type': 'application/json',
      'user-agent': 'dsh-cairn-bootstrap'
    },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status} ${await res.text()}`);
  return res.status === 204 ? undefined : res.json();
}

const args = parseArgs(process.argv);
const token = process.env.GITHUB_TOKEN;
if (!token) throw new Error('GITHUB_TOKEN is required');

const [owner, name] = args.repo.split('/');
if (!owner || !name) throw new Error('--repo must look like owner/name');
const base = `/repos/${owner}/${name}`;

const dirty = git(['status', '--porcelain']);
if (dirty.length > 0) throw new Error(`working tree is dirty; commit first:\n${dirty}`);

/* ---- The repository itself ---------------------------------------------- */

let created = false;
try {
  await call(token, 'GET', base);
  console.log(`repo ${args.repo} already exists`);
} catch (error) {
  if (!String(error.message).startsWith('GET ')) throw error;
  await call(token, 'POST', '/user/repos', {
    name,
    description: args.description,
    private: args.private,
    has_issues: true,
    has_wiki: false
  });
  created = true;
  console.log(`created ${args.repo}`);
}

// A repository with no commits rejects blob creation with 409 ("Git
// Repository is empty"), so it needs one commit before the tree exists. Seed a
// throwaway file through the contents API — the only endpoint that creates an
// initial commit — and drop it from history below by pointing the branch at the
// parentless commit.
const isEmpty = await call(token, 'GET', `${base}/commits`).then((list) => list.length === 0).catch(() => true);
if (isEmpty) {
  await call(token, 'PUT', `${base}/contents/.bootstrap`, {
    message: 'seed',
    content: Buffer.from('seed\n').toString('base64')
  });
  console.log('seeded the empty repository so it will accept blobs');
}
if (args.dryRun) process.exit(0);

/* ---- One blob per tracked file, then one tree --------------------------- */

const entries = git(['ls-tree', '-r', '--full-tree', 'HEAD'])
  .split('\n')
  .filter(Boolean)
  .map((line) => {
    const [meta, path] = line.split('\t');
    const [mode, type] = meta.split(/\s+/);
    return { mode, type, path };
  });

const tree = [];
for (const entry of entries) {
  const bytes = readFileSync(resolve(entry.path));
  const blob = await call(token, 'POST', `${base}/git/blobs`, {
    content: bytes.toString('base64'),
    encoding: 'base64'
  });
  tree.push({ path: entry.path, mode: entry.mode, type: 'blob', sha: blob.sha });
  console.log(`  blob ${entry.path} ${blob.sha.slice(0, 7)} ${bytes.length}B`);
}

const newTree = await call(token, 'POST', `${base}/git/trees`, { tree });

/* ---- The commit. No parents: this is the root of the history ------------ */

const identity = {
  name: git(['log', '-1', '--format=%an', 'HEAD']),
  email: git(['log', '-1', '--format=%ae', 'HEAD']),
  date: git(['log', '-1', '--format=%aI', 'HEAD'])
};

const commit = await call(token, 'POST', `${base}/git/commits`, {
  message: git(['log', '-1', '--format=%B', 'HEAD']),
  tree: newTree.sha,
  parents: [],
  author: identity,
  committer: identity
});

// The seed commit above already created `refs/heads/<branch>`, so it has to be
// moved rather than created.
const existing = await call(token, 'GET', `${base}/git/ref/heads/${args.branch}`).catch(() => undefined);
if (existing === undefined) {
  await call(token, 'POST', `${base}/git/refs`, { ref: `refs/heads/${args.branch}`, sha: commit.sha });
} else {
  await call(token, 'PATCH', `${base}/git/refs/heads/${args.branch}`, { sha: commit.sha, force: true });
}

console.log(`\n${created ? 'created' : 'updated'} ${args.repo} @ ${commit.sha}`);
console.log(`now run: node scripts/adopt-remote-commit.mjs --repo ${args.repo} --sha ${commit.sha}`);
