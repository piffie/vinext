# vinext auto-reviewer

Automatic, read-only PR reviews — safe to run on PRs from any fork.
Built on [Flue](https://github.com/withastro/flue)'s virtual sandbox.

## What it is (and is not)

**It is:** a zero-privilege reviewer that runs on every PR. It reads the diff, PR metadata, and the current set of unresolved review threads, then posts one review that can:

- carry a **summary** with a verdict (`approve` / `request-changes` / `comment` — advisory text only; the bot always posts as a plain `COMMENT` review and never gates merges),
- attach **new inline comments** anchored to lines in the diff,
- **resolve existing review threads** that the latest push has addressed.

Think "linter with taste + review-thread janitor."

**It is not** a replacement for `/bonk` / `/bigbonk`. Those are maintainer-triggered, have `contents: write`, and can edit code. This agent has no write tools, no network, no binaries.

## Triggers

- `pull_request_target` on `opened` (non-draft) and `ready_for_review`.
- `issue_comment` created on a PR whose body contains `/review`, gated on `author_association ∈ {MEMBER, COLLABORATOR, OWNER}` and `sender.type != 'Bot'` — fork authors cannot self-trigger.

No `synchronize` trigger: re-reviews are explicit via `/review` from a maintainer. This keeps noise down and makes the review artifact tied to a specific commit the maintainer asked about.

For `issue_comment`, GitHub always runs the workflow file from the default branch tip — forks cannot substitute their own workflow definition, even if they've modified `.github/workflows/review-pr.yml` in their branch.

## Threat model

A hostile fork has three attack surfaces: (1) what they can put in PR content, (2) what they can make the workflow do via event payloads, (3) what they can make the agent do via the LLM.

### Fork-controlled content → agent

| Threat | Mitigation |
| --- | --- |
| Prompt injection in file contents, PR body, commit messages, or comment bodies | Agent told in [AGENTS.md](AGENTS.md) to treat all of those as untrusted. Output is a valibot schema, so even a fully compromised model can only fill validated fields. |
| Prompt injection steering tool use | Agent runs in a just-bash `InMemoryFs` seeded only with `/AGENTS.md`, `/.agents/`, and `/workspace/` — nothing else from the host is in the VFS. `curl`/`wget`/`fetch` require explicit `NetworkConfig` which we don't supply. `python`/`javascript` are opt-in flags we leave off. No `defineCommand` call. |
| Agent reading host env, `/proc/self/environ`, `~/.ssh`, `/home/runner/...` | Those paths are not in the VFS. Reading them returns ENOENT. The Node host's `process.env` is also not propagated into `new Bash({ env: {} })`, so `env` / `printenv` / `echo $VAR` see nothing inside the sandbox. |
| Agent writing to host files (`scripts/post.mjs`, `workspace/metadata.json`) to bypass validation | Writes land in VFS memory only. The real host filesystem is never exposed to the agent's tools — `post.mjs` reads the real `workspace/metadata.json` that prestage wrote; the agent cannot touch it. |
| Forged file paths in findings | [`post.mjs`](scripts/post.mjs) rejects any `file` not in `metadata.paths` (API-derived allowlist). |
| Inline comments posted to arbitrary lines | `post.mjs` rejects any `line` not in `metadata.hunkLines[file]` (RIGHT-side lines present in the diff). |
| Agent resolving threads it shouldn't | `post.mjs` rejects any `threadId` not in `threads.json`. |
| Same issue re-commented on rerun | `post.mjs` drops new comments whose `(path, line)` already has an unresolved bot thread. |
| Path-traversal via filename in `git archive`/`tar` | `git archive` emits only tracked blobs; GNU `tar` rejects paths containing `..` by default. Files that landed outside `workspace/pr/` or `workspace/base/` still couldn't influence the posted review because `post.mjs` re-validates every emitted `file` against the API-derived `paths` allowlist. |
| Resource exhaustion via diff or tree size | Hard caps in `prestage.mjs`: 500 KB diff, 100 changed files, 10 KB PR body, 100 threads, 512 KB per tree file, 300 MB per tree total. Bail with exit 2 if exceeded. |
| Malicious content in a committed file influencing the agent | The full tree at both revs is loaded into the VFS as text — but the agent is in a network-less, subprocess-less sandbox and its only output channel is the schema-validated review. PR content is just more bytes for the agent to read. |

### Fork-controlled workflow inputs

| Threat | Mitigation |
| --- | --- |
| Fork modifying `.github/workflows/review-pr.yml` | `pull_request_target` and `issue_comment` both run the workflow from the **base ref**, never the fork. The fork's copy of the file is irrelevant. |
| Shell injection via event fields (title, branch name, author login) | Prestage reads **nothing** from the workflow event payload beyond `PR_NUMBER` (integer-validated) and `BASE_REPO` (regex-validated). Everything else — head SHA, base SHA, title, body, author — comes from `gh pr view` where values are JSON-typed, never shell-interpolated. All child processes use `execFile`/array args, never `sh -c`. |
| Fork PR author self-triggering the reviewer | `ready_for_review`/`opened` is acceptable (the PR author controls draft state anyway). `/review` is gated on `author_association ∈ {MEMBER, COLLABORATOR, OWNER}`. |
| `sender.type == 'Bot'` triggering `/review` in a loop | Explicit `sender.type != 'Bot'` gate on the issue_comment branch. |

### Secret-exfiltration paths

| Threat | Mitigation |
| --- | --- |
| PR code with `postinstall` hooking npm | Checkout is **base, sparse (agents/reviewer/ only)**. PR code is never on disk in the flue project. `npm install --ignore-scripts`. |
| PR git hooks running during fetch | `prestage.mjs` uses `git archive` (no hooks) in a **scratch dir outside the flue project** (`$GIT_SCRATCH_DIR`, default `$RUNNER_TEMP`). The scratch dir is `rm -rf`'d after extraction. |
| GH token written to `.git/config` (where the agent could read it) | We authenticate via `-c http.extraHeader=AUTHORIZATION: Bearer ...` on the fetch subcommand only. The token never lands in any config file. |
| Agent reading `/proc/self/environ` to steal env | Two layers: (1) `/proc/` does not exist in the just-bash VFS, so the agent has nothing to read in the first place. (2) Defence in depth — the `Run reviewer agent` step wraps `npx flue run` with `env -i`, passing only `PATH`, `HOME`, `LANG`, `ANTHROPIC_API_KEY`, `FLUE_REVIEW_MODEL`. So even if the VFS abstraction ever leaked, the Node process's env is already minimal. |
| Agent putting the Anthropic key (or any token) into the posted review body | `post.mjs` runs a **token-pattern scan** over every agent-supplied string (`summary`, every `message`, every `reason`). Any match withholds the entire review and fails the job. Patterns cover GitHub (PAT/server/fine-grained/OAuth/user/refresh), Anthropic `sk-ant-`, OpenAI `sk-`, AWS access keys, Slack, Google API, and PEM private keys. |
| Prestage leaving `.git` or credential files where the agent can see | Every git operation is confined to `$GIT_SCRATCH_DIR` outside the flue project; the dir is deleted after use. The Next.js cache has its `.git/` deleted post-clone. |
| `pull_request_target` giving PR code write tokens | The PR is never checked out. Only `agents/reviewer/` from base is on disk. PR files live under `workspace/pr/` as inert data. |
| Compromised agent writing to `post.mjs` or mutating allowlists | Writes go to the in-memory VFS, not the real filesystem. `post.mjs` and the real `workspace/metadata.json` / `workspace/threads.json` sit on disk untouched; the agent's VFS copy of those paths is a separate object. Mutations to the VFS die when the Node process exits. |

### What we're still trusting

These are assumptions, not mitigations. If they turn out to be wrong, the model changes.

1. **just-bash's `InMemoryFs` does not escape to the host.** The entire just-bash filesystem is an in-process JS Map; paths resolve inside that Map. No syscalls to host `fs`. We rely on this being true — it's the library's core design, not something we configured.
2. **just-bash does not spawn subprocesses unless `network` / `python` / `javascript` / `customCommands` are explicitly configured.** We pass none of those. `curl` specifically is gated behind `NetworkConfig`.
3. **`execFile` with an array doesn't invoke a shell.** Standard Node guarantee; we rely on it for all subprocess invocations in prestage and post.
4. **GitHub Actions does not auto-inject secrets into step env.** Every secret in every step is one we wrote by name.
5. **`env -i` inside a `run:` block actually strips the env of the spawned subprocess.** Standard GNU coreutils behaviour.

The token-pattern scan in `post.mjs` is the defence-in-depth against (1) or (2) being wrong: if the sandbox ever gained a way to read a secret, the secret still couldn't escape through the one public output channel we have.

## Layout

```
agents/reviewer/
├── package.json              # @flue/sdk, @flue/cli, valibot
├── AGENTS.md                 # top-level rules the agent reads
├── .agents/skills/review-pr/SKILL.md
├── .flue/agents/review.ts    # agent: builds just-bash VFS + session.skill('review-pr')
├── .flue/sandbox/load-vfs.ts # host-tree → VFS loader (text-only, size-capped)
└── scripts/
    ├── prestage.mjs          # host-side: builds workspace/ from GH API
    ├── post.mjs              # host-side: validates + posts the review
    └── run-local.mjs         # dev-side: run end-to-end, dry-run post
```

And the CI side:

```
.github/workflows/review-pr.yml
```

## Flow

```
PR ready_for_review / opened (non-draft)              /review comment from maintainer
            │                                                      │
            └──────────────────────────┬───────────────────────────┘
                                       ▼
                 workflow runs from base branch's YAML
                 (never the fork's copy)
                                       │
                                       ▼
 ┌─────────────────────────────────────────────────────────────────┐
 │ Step 1. Sparse checkout of agents/reviewer/ from base              │
 │         persist-credentials: false                              │
 │         npm install --ignore-scripts                            │
 ├─────────────────────────────────────────────────────────────────┤
 │ Step 2. prestage.mjs       (has GH_TOKEN)                       │
 │   → resolves PR via gh pr view (one canonical source)           │
 │   → gh pr diff  → workspace/diff.patch                          │
 │   → git fetch in $RUNNER_TEMP/vinext-prestage-git/              │
 │       auth via -c http.extraHeader (not URL-embedded)           │
 │       fetches both head sha and base sha in one go              │
 │   → git archive | tar -x   → workspace/pr/    (full tree @ head)│
 │                            → workspace/base/  (full tree @ base)│
 │   → rm -rf scratch dir                                          │
 │   → pinned sparse next.js clone → workspace/nextjs/ (symlink)   │
 │   → threads via GraphQL → workspace/threads.json                │
 │   → workspace/metadata.json (pr info, paths, hunkLines, SHAs)   │
 ├─────────────────────────────────────────────────────────────────┤
 │ Step 3. env -i + flue run review  (minimal env)                 │
 │   env: PATH, HOME, LANG, ANTHROPIC_API_KEY, FLUE_REVIEW_MODEL   │
 │   review.ts builds a just-bash InMemoryFs seeded with:          │
 │     /AGENTS.md, /.agents/, /workspace/                          │
 │   nothing else is reachable — no host fs, no network, no env    │
 │   → LLM output matches valibot schema                           │
 │   → trusted Node code (review.ts) writes workspace/result.json  │
 │     (agent cannot influence this path; its VFS is isolated)     │
 ├─────────────────────────────────────────────────────────────────┤
 │ Step 4. post.mjs       (has GH_TOKEN)                           │
 │   1. schema re-parse                                            │
 │   2. TOKEN-PATTERN SCAN — any match ⇒ withhold review, exit 4   │
 │   3. file ∈ paths / line ∈ hunkLines / threadId ∈ threads       │
 │   4. dedup vs existing bot threads                              │
 │   5. POST /repos/.../pulls/:n/reviews  (event: COMMENT)         │
 │   6. resolveReviewThread mutation per validated id              │
 └─────────────────────────────────────────────────────────────────┘
```

## Running locally

```bash
cd agents/reviewer
npm install
export GH_TOKEN=...            # a PAT with repo:read
export ANTHROPIC_API_KEY=...
node scripts/run-local.mjs vercel/next.js#70000
```

This prestages, runs the agent, and dry-run-prints the review. No comment is posted.

## Tuning knobs

| Env var | Default | Purpose |
| --- | --- | --- |
| `FLUE_REVIEW_MODEL` | `anthropic/claude-opus-4-7` | Swap the model. Any string Flue accepts. Set via GitHub Actions `vars.FLUE_REVIEW_MODEL`. |
| `NEXTJS_REF` | `v15.0.3` | Pinned ref for the reference clone. Bump periodically. |
| `NEXTJS_CACHE_DIR` | `.nextjs-cache` | Where the cached sparse clone lives. CI caches this. |
| `GIT_SCRATCH_DIR` | `$RUNNER_TEMP/vinext-prestage-git` | Throwaway dir for prestage's git fetches. Outside the flue project on purpose. |

## Extending

- **LEFT-side inline comments** (on deleted lines). Today `post.mjs` only accepts RIGHT-side lines. To enable LEFT, parse both `-` and `+` lines into `hunkLines` with a `side` tag and let the agent emit `side` per comment.
- **Multi-line / range comments** — `POST .../reviews` accepts `start_line` + `line`. Add to the schema and validate both ends are in `hunkLines`.
- **Additional agents in the same project** — drop another file in `.flue/agents/`. For anything that needs write tools (a future Flue-based `/bonk`), use a Daytona container sandbox + scoped `defineCommand`, and put it behind a comment-triggered workflow.
- **Skipping PRs** — add a label or path filter in `review-pr.yml`.

## Caveats

- Flue is experimental (0.2.x). Pin versions in `package.json`; expect API churn.
- The reviewer assumes the PR diff is the whole story. Cross-file semantic issues that require the full repo checked out are out of scope by design.
- `actions/cache` is best-effort; a cache miss just means a slower first-PR run while the Next.js ref is cloned.
- The bot always posts reviews with `event: COMMENT`. The model's `verdict` is text in the summary, never an actual GitHub approval/change-request state. If you want the bot to block merges on `request-changes`, flip `event` in `post.mjs` — but understand the failure modes first (a hallucinated `request-changes` on a fork PR is friction that humans then have to clear).
