#!/usr/bin/env node
// Host-side poster: runs OUTSIDE the agent sandbox, with GH_TOKEN.
//
// Reads workspace/result.json and enforces, in order:
//   1. schema  — valibot re-parse.
//   2. content — TOKEN SCAN: reject the ENTIRE review if any agent-supplied
//                text contains a substring that looks like a GitHub, Anthropic,
//                AWS, or other well-known secret. Fail closed.
//   3. paths   — file ∈ metadata.paths.
//   4. lines   — line ∈ metadata.hunkLines[file] (RIGHT side).
//   5. threads — threadId ∈ threads.json.
//   6. dedup   — drop new_comments whose (path, line) already has an unresolved
//                bot thread.
//
// Then posts ONE review (POST /repos/.../pulls/:n/reviews, event: COMMENT)
// carrying the summary body + validated inline comments. Resolves threads
// via `resolveReviewThread` mutation.
//
// This step is deliberately not an LLM.

import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import * as v from 'valibot';

const Category = v.picklist([
	'bug',
	'regression',
	'security',
	'perf',
	'api',
	'test-gap',
	'style',
]);
const NewInlineComment = v.object({
	file: v.pipe(v.string(), v.minLength(1), v.maxLength(512)),
	line: v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(1_000_000)),
	category: Category,
	message: v.pipe(v.string(), v.minLength(1), v.maxLength(800)),
});
const ResolveThread = v.object({
	threadId: v.pipe(v.string(), v.minLength(1), v.maxLength(200)),
	reason: v.pipe(v.string(), v.minLength(1), v.maxLength(400)),
});
const ReviewSchema = v.object({
	verdict: v.picklist(['approve', 'request-changes', 'comment']),
	severity: v.picklist(['none', 'low', 'medium', 'high', 'critical']),
	summary: v.pipe(v.string(), v.maxLength(4000)),
	new_comments: v.pipe(v.array(NewInlineComment), v.maxLength(50)),
	resolve_threads: v.pipe(v.array(ResolveThread), v.maxLength(50)),
});

// Any match here causes the entire review to be withheld. These patterns
// are intentionally broad — false positives mean a review is dropped and a
// human is told; false negatives mean a secret gets posted publicly.
const TOKEN_PATTERNS = [
	{ name: 'github-pat', re: /\bghp_[A-Za-z0-9]{30,}/ },
	{ name: 'github-server-token', re: /\bghs_[A-Za-z0-9]{30,}/ },
	{ name: 'github-fine-grained', re: /\bgithub_pat_[A-Za-z0-9_]{40,}/ },
	{ name: 'github-oauth', re: /\bgho_[A-Za-z0-9]{30,}/ },
	{ name: 'github-user-token', re: /\bghu_[A-Za-z0-9]{30,}/ },
	{ name: 'github-refresh', re: /\bghr_[A-Za-z0-9]{30,}/ },
	{ name: 'anthropic', re: /\bsk-ant-[A-Za-z0-9_-]{20,}/ },
	{ name: 'openai', re: /\bsk-[A-Za-z0-9]{32,}/ },
	{ name: 'aws-access-key', re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/ },
	{ name: 'private-key-pem', re: /-----BEGIN (?:RSA |EC |OPENSSH |DSA |ENCRYPTED )?PRIVATE KEY-----/ },
	{ name: 'slack-token', re: /\bxox[baprs]-[A-Za-z0-9-]{10,}/ },
	{ name: 'google-api', re: /\bAIza[0-9A-Za-z_-]{35}\b/ },
];

const BOT_MARKER = '<!-- vinext-auto-reviewer -->';
const BOT_LOGIN = 'github-actions[bot]';
const CONTROL_CHARS = /[\x00-\x08\x0B\x0C\x0E-\x1F]/g;

const dryRun = process.argv.includes('--dry-run') || process.env.POST_DRY_RUN === '1';
const ghToken = process.env.GH_TOKEN;
if (!dryRun && !ghToken) {
	console.error('post: missing GH_TOKEN');
	process.exit(2);
}

const workspace = resolve('workspace');
const metadata = JSON.parse(readFileSync(`${workspace}/metadata.json`, 'utf8'));
const threads = JSON.parse(readFileSync(`${workspace}/threads.json`, 'utf8'));

const prNumber = metadata.number;
const baseRepo = metadata.baseRepo;
const headSha = metadata.headSha;

const allowedPaths = new Set(metadata.paths);
const hunkLines = Object.fromEntries(
	Object.entries(metadata.hunkLines ?? {}).map(([k, lines]) => [k, new Set(lines)]),
);
const allowedThreadIds = new Set(threads.map((t) => t.id));
const botThreadsByPathLine = new Set(
	threads
		.filter((t) => t.comments?.some((c) => c.author === BOT_LOGIN))
		.map((t) => `${t.path}:${t.line}`),
);

// 1. Schema.
const raw = JSON.parse(readFileSync(`${workspace}/result.json`, 'utf8'));
const parsed = v.safeParse(ReviewSchema, raw);
if (!parsed.success) {
	console.error('post: result.json failed schema validation');
	console.error(JSON.stringify(parsed.issues, null, 2));
	process.exit(3);
}
const review = parsed.output;

// 2. Token scan. Fail closed — any match, whole review withheld.
const allAgentText = [
	review.summary,
	...review.new_comments.map((c) => c.message),
	...review.resolve_threads.map((r) => r.reason),
].join('\n');
const hits = TOKEN_PATTERNS.filter((p) => p.re.test(allAgentText));
if (hits.length > 0) {
	console.error(
		`post: REVIEW WITHHELD — agent output contained ${hits.length} secret-shaped substring(s): ${hits
			.map((h) => h.name)
			.join(', ')}`,
	);
	// Do NOT print the offending text — even the log is not a safe place to
	// replicate a candidate secret. Upload workspace/result.json via the
	// failure-artifact step if you need to inspect (artifact is private to
	// the repo).
	process.exit(4);
}

const cleanText = (s) => s.replace(CONTROL_CHARS, '').trim();

// 3/4. Path + hunk-line allowlist. 6. Dedup.
const droppedReasons = [];
const newComments = [];
for (const c of review.new_comments) {
	const msg = cleanText(c.message);
	if (!msg) {
		droppedReasons.push(`empty message for ${c.file}:${c.line}`);
		continue;
	}
	if (!allowedPaths.has(c.file)) {
		droppedReasons.push(`file not in PR: ${c.file}`);
		continue;
	}
	if (!hunkLines[c.file]?.has(c.line)) {
		droppedReasons.push(`line not in diff hunk: ${c.file}:${c.line}`);
		continue;
	}
	if (botThreadsByPathLine.has(`${c.file}:${c.line}`)) {
		droppedReasons.push(`dedup — unresolved bot thread exists at ${c.file}:${c.line}`);
		continue;
	}
	newComments.push({
		path: c.file,
		line: c.line,
		side: 'RIGHT',
		body: `**${c.category}** — ${msg}`,
	});
}

// 5. Thread allowlist.
const resolves = [];
for (const r of review.resolve_threads) {
	if (!allowedThreadIds.has(r.threadId)) {
		droppedReasons.push(`thread id not in allowlist: ${r.threadId}`);
		continue;
	}
	resolves.push({ threadId: r.threadId, reason: cleanText(r.reason) });
}

const summary = cleanText(review.summary);
const body = renderSummary({
	verdict: review.verdict,
	severity: review.severity,
	summary,
	resolved: resolves,
	droppedReasons,
});

if (dryRun) {
	console.log('--- DRY RUN ---');
	console.log('[review body]');
	console.log(body);
	console.log('\n[inline comments]');
	for (const c of newComments) console.log(`  ${c.path}:${c.line} — ${c.body}`);
	console.log('\n[resolve threads]');
	for (const r of resolves) console.log(`  ${r.threadId} — ${r.reason}`);
	process.exit(0);
}

// Atomic post: body + inline comments as one review.
const reviewPayload = {
	commit_id: headSha,
	body,
	event: 'COMMENT', // never APPROVE or REQUEST_CHANGES — advisory only.
	comments: newComments.map((c) => ({
		path: c.path,
		line: c.line,
		side: c.side,
		body: c.body,
	})),
};
ghApi('POST', `/repos/${baseRepo}/pulls/${prNumber}/reviews`, reviewPayload);
console.log(`post: review posted with ${newComments.length} inline comment(s)`);

// Resolve threads.
for (const r of resolves) {
	try {
		ghGraphql(
			'mutation($id:ID!){ resolveReviewThread(input:{threadId:$id}){ thread { id isResolved } } }',
			{ id: r.threadId },
		);
		console.log(`post: resolved ${r.threadId}`);
	} catch (e) {
		console.warn(`post: failed to resolve ${r.threadId}: ${e.message}`);
	}
}

function ghApi(method, path, body) {
	return execFileSync('gh', ['api', '--method', method, path, '--input', '-'], {
		env: { ...process.env, GH_TOKEN: ghToken },
		input: JSON.stringify(body),
		encoding: 'utf8',
		stdio: ['pipe', 'pipe', 'inherit'],
	});
}
function ghGraphql(query, variables) {
	return execFileSync('gh', ['api', 'graphql', '--input', '-'], {
		env: { ...process.env, GH_TOKEN: ghToken },
		input: JSON.stringify({ query, variables }),
		encoding: 'utf8',
		stdio: ['pipe', 'pipe', 'inherit'],
	});
}

function renderSummary({ verdict, severity, summary, resolved, droppedReasons }) {
	const verdictLabel = {
		approve: '✓ looks good',
		'request-changes': '⚠ changes requested',
		comment: 'ℹ comments',
	}[verdict];
	const header = `### Automated review — ${verdictLabel} · severity: \`${severity}\`\n`;
	const note =
		'_Advisory. Read-only analysis from a sealed sandbox (no network, no repo write tools). Not a merge gate._\n';
	const summaryBlock = summary ? `\n${summary}\n` : '';
	const resolvedBlock =
		resolved.length > 0
			? '\n**Resolved threads:**\n' +
				resolved.map((r) => `- \`${r.threadId}\` — ${r.reason}`).join('\n') +
				'\n'
			: '';
	const dropped =
		droppedReasons.length > 0
			? `\n<details><summary>${droppedReasons.length} output(s) dropped during validation</summary>\n\n` +
				droppedReasons.map((r) => `- ${r}`).join('\n') +
				'\n\n</details>\n'
			: '';
	return BOT_MARKER + '\n' + header + note + summaryBlock + resolvedBlock + dropped;
}
