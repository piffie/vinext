// Reviewer agent. Runs in a fully isolated in-memory sandbox:
// - Filesystem: just-bash InMemoryFs, seeded with `AGENTS.md`, `.agents/`, and
//   `workspace/`. Nothing else from the host is visible to the agent's tools.
//   No /proc, no /etc, no /home, no agents/reviewer/scripts/, no process env
//   via `/proc/self/environ` (that file does not exist in the VFS).
// - Network: disabled. just-bash requires explicit NetworkConfig for `curl`.
// - Subprocess: disabled. No `python`/`javascript` opt-ins, no `defineCommand`.
//
// The LLM's session.skill() return value is schema-validated by Flue and
// passed back as a typed object. This trusted process then writes result.json
// to the real host filesystem for post.mjs to consume.

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Bash } from 'just-bash';
import type { FlueContext } from '@flue/sdk/client';
import * as v from 'valibot';
import { loadHostEntries } from '../sandbox/load-vfs.ts';

export const triggers = {};

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

export type Review = v.InferOutput<typeof ReviewSchema>;

export default async function ({ init }: FlueContext) {
	const metadata = JSON.parse(readFileSync('workspace/metadata.json', 'utf8')) as {
		number: number;
		pr: { title: string; body: string; author: string; labels: string[] };
		commits: { oid: string; message: string }[];
		paths: string[];
		hunkLines: Record<string, number[]>;
	};
	const threads = JSON.parse(readFileSync('workspace/threads.json', 'utf8')) as unknown[];

	// Build the agent's filesystem. The LLM's read/write/grep/glob/bash tools
	// see exactly these files, addressed by their VFS paths (/AGENTS.md,
	// /.agents/..., /workspace/...). Everything else returns ENOENT inside the
	// sandbox.
	const files = loadHostEntries(resolve('.'), '', ['AGENTS.md', '.agents', 'workspace']);

	const bash = new Bash({
		files,
		cwd: '/',
		// network: NOT configured → curl/wget/fetch all unavailable.
		// python/javascript: NOT enabled → no real language runtimes.
		// env: intentionally empty so env vars in the Node host don't bleed
		// into the shell's $VAR expansion or `env` / `printenv` output.
		env: {},
	});

	const session = await init({
		sandbox: bash,
		model: process.env.FLUE_REVIEW_MODEL ?? 'anthropic/claude-opus-4-7',
	});

	const result = await session.skill('review-pr', {
		args: {
			prNumber: metadata.number,
			prTitle: metadata.pr.title,
			prAuthor: metadata.pr.author,
			changedPaths: metadata.paths,
			unresolvedThreadCount: threads.length,
			commitCount: metadata.commits.length,
		},
		result: ReviewSchema,
	});

	// Trusted write outside the sandbox. The agent has no way to influence
	// this path — result is already schema-validated by the time we see it.
	writeFileSync('workspace/result.json', JSON.stringify(result, null, 2));
	return result;
}
