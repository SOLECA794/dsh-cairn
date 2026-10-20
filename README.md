# dsh-cairn

A cairn is a stack of stones each traveller adds so the next one can find the path. This is that,
for [dsh](https://github.com/deepseek-ai/deepseek-harness) coding sessions — a plugin that makes
*"was this change actually verified?"* a question with an answer, instead of a question the model
answers about itself.

Tested: **158 unit tests**, **24 `apply()` smoke checks** against a mock context, and a dry run on
a real repository.

## The problem

The cheapest lie in a coding session is a confident *done*. It costs nothing to type, it is never
audited, and the harness has no opinion about it:

- The model edits four files, runs the one check it remembers, and reports success. The fifth file
  was written *after* the check and nobody noticed, because "did the tests pass" was asked about
  the session, not about the file.
- A check fails on turn 3, the model moves on, and by turn 9 it reports a passing build from a
  session where the last thing that ran was red.
- The repository says *"touch the kernel, run the regression"* in `AGENTS.md`. Nothing enforces
  prose.

None of those are memory failures a longer context would fix. They are the absence of algebra:
**which writes does which check actually cover?** That is computable, and it is the whole plugin.

## What it does

| Seam | Behaviour | Cost |
|---|---|---|
| `.cairn/verify.json` | The project declares its checks as data — `test`, `build`, `typecheck`, `lint`, plus glob routes | free |
| ledger | Records every write, read, verification, and gated command, and attributes each verification to the writes it covers *by timestamp* | free |
| notice | Injects a `<cairn>` block **only when something is unverified**, naming the files and the declared command | a few hundred chars, conditionally |
| gate | Optionally refuses `present` / `git commit` while the claim is unsupported, with the reason attached | free |
| pheromones | Decaying per-path signals that outlive the session: *this file is fragile*, *this is the entry point* | free |

It saves no tokens. It spends a few hundred characters per injection and buys a smaller chance of
an unverified "done". `gate.mode: 'off'` stops the spending and keeps the accounting.

### It never executes anything

`lib/verify.js` reads a mapping from glob to command out of repository content. That is one
`spawn()` away from being a supply-chain bug: clone a repo, open it, and the repo runs code. So
this plugin does not run commands at all. The declared string is a *reminder* — the harness's own
shell tool is the only executor, with the user's permission preset in the loop. The trust gate
that design would need does not exist here, because the capability it gated does not exist.

The second deliberate departure: config is scoped to the project root only. No `~` fallback — a
route means "this repository wants this check", and inheriting one from `~` would make the same
working tree behave differently on two machines.

## Install

```sh
dsh plugin --profile <name> add dsh-cairn
```

Restart DSH afterwards. No config is required; every knob in `cordis.patch.yml` is optional and the
file only spells out the defaults.

Then declare what your project runs. Nothing else is needed — with no `.cairn/verify.json` the
plugin still keeps the ledger and still says *"this project declares no check for these paths"*:

```json
{
  "test": "cargo test",
  "build": "make build",
  "routes": [
    { "match": "src/kernel/**", "run": "bash tools/regress-rv64.sh", "note": "the RISC-V boot test" },
    { "match": "docs/**", "run": null }
  ]
}
```

Routes are matched by glob against the changed files; the first match per path wins, duplicates are
deduped, and a config that is broken in any way degrades to "no routes declared" — it never fails a
turn. A declared command must be a single line and under 500 characters, because it is rendered to
the model verbatim and a newline would let it impersonate a second instruction.

## What the notice looks like

It fires only when there is something to say. A fully verified session gets an empty string and
costs zero tokens.

```
<cairn>
VERIFICATION FAILED after the last write to src/net.rs (`cargo test`)
Do not report this work as done. Fix the failure or report it as failing.
2 changed file(s) have no verification after their last write: src/dns.rs, src/tls.rs
Declared checks for these paths (from .cairn/verify.json):
- `src/**/*.rs` → `cargo test`
</cairn>
```

Three rules decide that text, and all three are asserted in `tests/remind.test.js`:

1. **It names files and commands, never behaviour.** *"Consider verifying your changes"* is worse
   than nothing: it trains the model to skim a notice that never carries information. Every line
   here is either a path or a command.
2. **A failure outranks an omission.** `failed` > `unverified` > `blocked` > `verified`, and a
   `blocked` check never masks an unverified file — "the toolchain was missing" is not a pass.
3. **Elevation is honest.** If the check could not run, the notice says so and asks for the block
   to be reported as a block, rather than letting silence read as success.

## Why the ledger attributes by timestamp

The obvious implementation counts: *12 writes, 9 verifications, looks fine*. It is wrong in the
one case that matters. A check that ran before the last edit to a file proves nothing about that
edit, so `attribute()` gives every file the newest covering verification that ran **at or after**
its last write:

```
write a.rs → write b.rs → cargo test (passes) → edit a.rs
                             ↑ covers both      ↑ a.rs is unverified again; b.rs stays passed
```

A verification with no `files` list is global — it covers everything written before it, which is
the `make build` case. A verification with a `files` list covers only those. And a *ratio* would
have called the case above "83% verified", which ships. The ledger reports `1 of 6`, because the
question is never "how much is verified" but "is anything unverified".

## Pheromones: memory, with a half-life

Cross-session state is a liability that outlives the reason it was written. So signals decay, and
they reinforce only when they are observed again:

| Signal | Half-life | Deposited when |
|---|---|---|
| `fragile` | 7 days | A check failed after a write to this file, or it was written `fragileWrites` times in one session |
| `dead-end` | 7 days | A path was explored and abandoned |
| `well-tested` | 14 days | A passing check covered it |
| `refactor-candidate` | 14 days | Explicitly marked |
| `coupling-hub` | 21 days | Many callers |
| `performance-critical` | 30 days | Explicitly marked |
| `entry-point` | 30 days | Read `entryPointReads` times in one session |

Reinforcement is additive and capped at 1 (`min(1, decayed + added)`), and it restarts the clock —
so a file that keeps breaking climbs toward 1 while a one-off from last month fades out and is
pruned below 0.05. The store is capped at 200 entries and evicts the *weakest*, not the oldest.

Signals live at `$DSH_HOME/storages/dsh-cairn/signals-<hash of project root>.json`, so two projects
never inherit each other's opinions. They are advisory: the notice says *"verify before trusting"*,
and the ledger — not the pheromone — is what the gate reads.

## Tools

| Tool | What it answers |
|---|---|
| `cairn_status` | The delivery verdict: level, `canDeliver`, the reason, per-file attribution, recent verifications, and the declared checks. `{verbose: true}` for everything |
| `cairn_routes` | Which declared check applies to these files (or to the ones this session changed). Reports commands; never runs them |
| `cairn_signal` | `deposit` / `list` / `forget` — read and write the cross-session signals directly |

## Layout

```
lib/index.js        plugin wiring: config, listeners, tools, per-agent state
lib/verify.js       .cairn/verify.json parsing, glob routes, command classification
lib/ledger.js       per-session event log and per-file attribution
lib/pheromone.js    decaying cross-session signals, persisted atomically
lib/remind.js       the reminder text and its budget
lib/core.js         paths, globs, atomic writes, tag escaping
scripts/verify-apply.mjs    end-to-end run of apply() with no DSH installed
scripts/dry-run.mjs         what the plugin would say about your repository, without installing it
tests/                      unit suites per module (158 tests) + the tool stub
```

## Development

```sh
npm test        # 158 unit tests, node --test
npm run verify  # 24 apply() checks: registration, gate, ledger, persistence
```

`npm run verify` drives the real `apply()` through a mock context, using a module hook to stub
`@deepseek-ai/dsh-tools`, with `DSH_HOME` pointed at a temp directory. It walks one session in
order — write a file, inject the notice, hold the gate, run a failing check, run the declared
route, edit again, restart — because the seams are stateful and a broken link is only visible in
sequence.

### Try it on your project before installing it

The plugin's entire output is one conditional block of text, so the honest way to evaluate it is to
read that block for your own repository:

```sh
node scripts/dry-run.mjs --root ../my-project --files src/net.rs,src/dns.rs \
    --command "cargo test" --exit 1
```

It builds a mock context, replays the session you describe — the files that changed, then one shell
result passed in as a string, so nothing is executed — and prints the notice verbatim with its
character cost, the per-file ledger line, and the decision the gate would make. Point it at a
repository with no `.cairn/verify.json` to see what it says when a project declares nothing.

## Configuration

See [cordis.patch.yml](cordis.patch.yml) for every knob, written out with the shipped default and
why it is that value. The three that matter:

```yaml
gate:
  mode: remind   # remind | deny | off
  tools: [present]
  commands: [git commit, git push]
```

## License

Apache-2.0. Derivation notes in [NOTICE](NOTICE).
