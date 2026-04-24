#!/usr/bin/env node
// Host-side prestage: runs OUTSIDE the agent sandbox, with tokens.
//
// Inputs (env):
//   PR_NUMBER, BASE_REPO, GH_TOKEN             required
//   GIT_SCRATCH_DIR                            optional (default: os.tmpdir()/vinext-prestage-git)
//   NEXTJS_REF, NEXTJS_CACHE_DIR               optional
//
// Everything else (head/base SHA, title, body, author, labels, commits,
// changed paths, threads) is fetched from the GitHub API, which avoids
// shelling ANY fork-controlled strings.
//
// Outputs in ./workspace/:
//   diff.patch       — PR diff
//   pr/<path>        — PR-head file contents (via git archive; no hooks, no exec)
//   nextjs/          — pinned sparse Next.js clone (symlink to cache)
//   metadata.json    — pr info + paths + per-file hunk line sets
//   threads.json     — unresolved review threads
//
// Hardening notes:
// - Git work happens in $GIT_SCRATCH_DIR, OUTSIDE agents/reviewer/. No `.git/`
//   or credential artifacts ever land in the flue project dir.
// - Auth uses `-c http.extraHeader=...`, never a URL-embedded token, so the
//   token is never written to `.git/config` on disk.
// - Hard caps on diff size, file count, per-file size, PR body, threads.

import { execFileSync, execSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const MAX_DIFF_BYTES = 500_000;
const MAX_CHANGED_FILES = 100;
const MAX_TREE_FILE_BYTES = 512_000; // per-file cap on extracted tree content
const MAX_TREE_TOTAL_BYTES = 300_000_000; // sanity cap on total extracted tree size
const MAX_PR_BODY_BYTES = 10_000;
const MAX_THREADS = 100;
const MAX_COMMENTS_PER_THREAD = 20;
const NEXTJS_REF = process.env.NEXTJS_REF ?? 'v15.0.3';
const NEXTJS_SPARSE_PATHS = ['packages/next/src'];

function die(msg) {
	console.error(`prestage: ${msg}`);
	process.exit(2);
}
function requireEnv(name) {
	const v = process.env[name];
	if (!v) die(`missing env: ${name}`);
	return v;
}
function run(cmd, args, opts = {}) {
	return execFileSync(cmd, args, {
		encoding: 'utf8',
		stdio: ['ignore', 'pipe', 'inherit'],
		...opts,
	});
}

const prNumber = Number(requireEnv('PR_NUMBER'));
if (!Number.isInteger(prNumber) || prNumber <= 0) die(`invalid PR_NUMBER: ${process.env.PR_NUMBER}`);
const baseRepo = requireEnv('BASE_REPO');
if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(baseRepo)) die(`invalid BASE_REPO: ${baseRepo}`);
const ghToken = requireEnv('GH_TOKEN');
const [owner, repoName] = baseRepo.split('/');
const gitScratch = resolve(process.env.GIT_SCRATCH_DIR ?? join(tmpdir(), 'vinext-prestage-git'));

const gh = (args, opts = {}) =>
	run('gh', args, { env: { ...process.env, GH_TOKEN: ghToken }, ...opts });

const workspace = resolve('workspace');
rmSync(workspace, { recursive: true, force: true });
mkdirSync(workspace, { recursive: true });
mkdirSync(join(workspace, 'pr'), { recursive: true });

// 1. Resolve the PR: title, body, author, labels, commits, SHAs, base ref.
//    We do this ourselves via gh rather than trusting workflow-provided env,
//    so there's one canonical source of truth and one code path for both
//    `pull_request_target` and `/review` comment triggers.
const prJson = gh([
	'pr',
	'view',
	String(prNumber),
	'--repo',
	baseRepo,
	'--json',
	'number,title,body,author,labels,commits,headRefOid,baseRefOid,baseRefName,isDraft,state',
]);
const prInfo = JSON.parse(prJson);
if (prInfo.state !== 'OPEN') die(`PR is not open (state=${prInfo.state})`);
if (prInfo.isDraft) die('PR is draft');
const headSha = prInfo.headRefOid;
const baseSha = prInfo.baseRefOid;
const baseRef = prInfo.baseRefName;
if (!/^[0-9a-f]{40}$/.test(headSha)) die(`bad head sha: ${headSha}`);
if (!/^[0-9a-f]{40}$/.test(baseSha)) die(`bad base sha: ${baseSha}`);

const prBody = truncate(prInfo.body ?? '', MAX_PR_BODY_BYTES, '\n\n…[truncated]');
const commits = (prInfo.commits ?? []).slice(-20).map((c) => ({
	oid: c.oid,
	message: truncate(c.messageHeadline ?? '', 300),
}));

// 2. Diff.
const diff = gh(['pr', 'diff', String(prNumber), '--repo', baseRepo], {
	maxBuffer: MAX_DIFF_BYTES + 1,
});
if (Buffer.byteLength(diff, 'utf8') > MAX_DIFF_BYTES) {
	die(`diff exceeds ${MAX_DIFF_BYTES} bytes — too large to review automatically`);
}
writeFileSync(join(workspace, 'diff.patch'), diff);

// 3. Changed files + per-file hunk line sets (for later inline-comment validation).
const filesJson = gh([
	'api',
	`repos/${baseRepo}/pulls/${prNumber}/files`,
	'--paginate',
	'-q',
	'[.[] | {path: .filename, status: .status, additions: .additions, deletions: .deletions, patch: .patch}]',
]);
const files = JSON.parse(filesJson);
if (files.length > MAX_CHANGED_FILES) {
	die(`PR changes ${files.length} files (limit ${MAX_CHANGED_FILES})`);
}
const paths = files.filter((f) => f.status !== 'removed').map((f) => f.path);
const hunkLines = {};
for (const f of files) {
	if (!f.patch) continue;
	const set = new Set();
	let cursor = 0;
	for (const rawLine of f.patch.split('\n')) {
		const hunk = rawLine.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/);
		if (hunk) {
			cursor = Number(hunk[1]);
			continue;
		}
		if (rawLine.startsWith('+') && !rawLine.startsWith('+++')) {
			set.add(cursor);
			cursor++;
		} else if (rawLine.startsWith(' ')) {
			set.add(cursor);
			cursor++;
		}
	}
	hunkLines[f.path] = [...set].sort((a, b) => a - b);
}

// 4. PR-head file contents via `git archive` in a SCRATCH DIR outside the
//    flue project. The agent sandbox can read the flue project tree, so we
//    must not leave git config (which would embed the auth header) there.
rmSync(gitScratch, { recursive: true, force: true });
mkdirSync(gitScratch, { recursive: true });
const gitInScratch = (args, opts = {}) =>
	run('git', ['-C', gitScratch, ...args], { ...opts, stdio: ['ignore', 'pipe', 'inherit'] });

gitInScratch(['init', '-q']);
gitInScratch(['remote', 'add', 'origin', `https://github.com/${baseRepo}.git`]);
// Auth via -c http.extraHeader — one-shot, never persisted in .git/config.
// The header value is supplied via CLI args (not shell interpolation), and
// the token lives only in argv of this process and the subprocess.
const authHeader = `AUTHORIZATION: Bearer ${ghToken}`;
gitInScratch([
	'-c',
	`http.extraHeader=${authHeader}`,
	'fetch',
	'--depth=1',
	'--no-tags',
	'origin',
	`${headSha}:refs/vinext-review/head`,
	`${baseSha}:refs/vinext-review/base`,
]);

// Extract a whole ref's tracked tree into destDir via `git archive | tar -x`.
// Both commands use only validated inputs (refs are our `refs/vinext-review/*`
// strings, destDir is a path we constructed) so the shell pipeline is safe.
// `git archive` emits no hooks and no uncommitted content; `tar` rejects paths
// containing `..` by default.
function extractTree(ref, destDir) {
	mkdirSync(destDir, { recursive: true });
	execSync(`git archive --format=tar ${ref} | tar -x -C "${destDir}"`, {
		cwd: gitScratch,
		stdio: 'inherit',
	});
}

// Walk destDir; delete any single file above MAX_TREE_FILE_BYTES (usually
// large committed binaries — the diff still covers them if they changed).
// Also sum bytes and bail if the tree total is absurdly large.
function capTreeSize(destDir, label) {
	let total = 0;
	const walk = (dir) => {
		for (const name of readdirSync(dir)) {
			const full = join(dir, name);
			const st = statSync(full);
			if (st.isDirectory()) {
				walk(full);
			} else if (st.isFile()) {
				if (st.size > MAX_TREE_FILE_BYTES) {
					rmSync(full);
					continue;
				}
				total += st.size;
			}
		}
	};
	walk(destDir);
	if (total > MAX_TREE_TOTAL_BYTES) {
		die(`${label} tree exceeds ${MAX_TREE_TOTAL_BYTES} bytes — too large to review`);
	}
	return total;
}

// Full repo trees at both refs. The agent grep's/reads these freely:
//   workspace/pr/   — repo at PR head
//   workspace/base/ — repo at merge base
// It can compare any file at base vs head, not just the ones in the diff,
// which is the only way to reason about parity drift (dev vs prod vs
// Workers vs RSC entry) and about callsites of changed code.
extractTree('refs/vinext-review/head', join(workspace, 'pr'));
extractTree('refs/vinext-review/base', join(workspace, 'base'));
const prBytes = capTreeSize(join(workspace, 'pr'), 'pr');
const baseBytes = capTreeSize(join(workspace, 'base'), 'base');
// Scrub the scratch dir now that extraction is done. Belt and suspenders;
// it lives outside workspace/ but it contained the fetched ref.
rmSync(gitScratch, { recursive: true, force: true });

// 5. Next.js reference clone (pinned, sparse, cached). Cloned with no auth
//    (public repo). `.git` is deleted post-checkout so it's a pure source tree.
const cacheRoot = resolve(process.env.NEXTJS_CACHE_DIR ?? '.nextjs-cache');
const cacheDir = join(cacheRoot, NEXTJS_REF);
if (!existsSync(cacheDir)) {
	mkdirSync(cacheRoot, { recursive: true });
	execFileSync(
		'git',
		[
			'clone',
			'--depth=1',
			'--filter=blob:none',
			'--sparse',
			'--branch',
			NEXTJS_REF,
			'https://github.com/vercel/next.js.git',
			cacheDir,
		],
		{ stdio: 'inherit' },
	);
	execFileSync('git', ['-C', cacheDir, 'sparse-checkout', 'set', ...NEXTJS_SPARSE_PATHS], {
		stdio: 'inherit',
	});
	rmSync(join(cacheDir, '.git'), { recursive: true, force: true });
}
execFileSync('ln', ['-sfn', cacheDir, join(workspace, 'nextjs')]);

// 6. Unresolved review threads via GraphQL.
const threadsQuery = `
query($owner:String!,$name:String!,$num:Int!) {
  repository(owner:$owner,name:$name) {
    pullRequest(number:$num) {
      reviewThreads(first:100) {
        nodes {
          id
          isResolved
          isOutdated
          path
          line
          originalLine
          startLine
          comments(first:${MAX_COMMENTS_PER_THREAD}) {
            nodes {
              databaseId
              author { login }
              body
              createdAt
              url
            }
          }
        }
      }
    }
  }
}`;
const threadsRaw = gh([
	'api',
	'graphql',
	'-f',
	`query=${threadsQuery}`,
	'-F',
	`owner=${owner}`,
	'-F',
	`name=${repoName}`,
	'-F',
	`num=${prNumber}`,
]);
const threadsParsed = JSON.parse(threadsRaw);
const allThreads = threadsParsed.data?.repository?.pullRequest?.reviewThreads?.nodes ?? [];
const unresolved = allThreads
	.filter((t) => !t.isResolved)
	.slice(0, MAX_THREADS)
	.map((t) => ({
		id: t.id,
		path: t.path,
		line: t.line ?? t.originalLine ?? null,
		isOutdated: t.isOutdated,
		comments: (t.comments?.nodes ?? []).map((c) => ({
			author: c.author?.login ?? '<unknown>',
			body: truncate(c.body ?? '', 4000, '…[truncated]'),
			createdAt: c.createdAt,
			url: c.url,
		})),
	}));
writeFileSync(join(workspace, 'threads.json'), JSON.stringify(unresolved, null, 2));

// 7. Metadata. PR_HEAD_SHA flows from prestage → post via this file.
writeFileSync(
	join(workspace, 'metadata.json'),
	JSON.stringify(
		{
			number: prNumber,
			baseRepo,
			baseRef,
			baseSha,
			headSha,
			pr: {
				title: prInfo.title,
				body: prBody,
				author: prInfo.author?.login ?? '<unknown>',
				labels: (prInfo.labels ?? []).map((l) => l.name),
			},
			commits,
			paths,
			hunkLines,
		},
		null,
		2,
	),
);

console.log(
	`prestage: ok — ${paths.length} changed paths, ` +
		`${Buffer.byteLength(diff, 'utf8')} diff bytes, ` +
		`pr-tree=${prBytes}B base-tree=${baseBytes}B, ` +
		`${unresolved.length} unresolved threads`,
);

function truncate(s, max, suffix = '…') {
	if (!s) return '';
	const buf = Buffer.from(s, 'utf8');
	if (buf.byteLength <= max) return s;
	return buf.subarray(0, max).toString('utf8') + suffix;
}
