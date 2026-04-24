#!/usr/bin/env node
// Local demo runner. Fetches a real PR, prestages, runs the agent, and
// prints the would-be review without posting it.
//
// Usage:
//   GH_TOKEN=... ANTHROPIC_API_KEY=... node scripts/run-local.mjs <owner/repo>#<number>

import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

const spec = process.argv[2];
const m = spec?.match(/^([^/]+\/[^#]+)#(\d+)$/);
if (!m) {
	console.error('usage: run-local.mjs <owner/repo>#<number>');
	process.exit(64);
}
const [, baseRepo, prNumber] = m;

const ghToken = process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN;
if (!ghToken) {
	console.error('run-local: set GH_TOKEN (or GITHUB_TOKEN).');
	process.exit(2);
}
if (!process.env.ANTHROPIC_API_KEY) {
	console.error('run-local: set ANTHROPIC_API_KEY.');
	process.exit(2);
}

const cwd = resolve(new URL('..', import.meta.url).pathname);
const baseEnv = { ...process.env, GH_TOKEN: ghToken, BASE_REPO: baseRepo, PR_NUMBER: prNumber };

// prestage
execFileSync('node', ['scripts/prestage.mjs'], { cwd, env: baseEnv, stdio: 'inherit' });

// agent — mirror the workflow's minimal-env wrapping.
execFileSync(
	'env',
	[
		'-i',
		`PATH=${process.env.PATH}`,
		`HOME=${process.env.HOME}`,
		`LANG=${process.env.LANG ?? 'C.UTF-8'}`,
		`ANTHROPIC_API_KEY=${process.env.ANTHROPIC_API_KEY}`,
		`FLUE_REVIEW_MODEL=${process.env.FLUE_REVIEW_MODEL ?? ''}`,
		'npx',
		'flue',
		'run',
		'review',
		'--target',
		'node',
	],
	{ cwd, stdio: 'inherit' },
);

// post (dry run)
execFileSync('node', ['scripts/post.mjs', '--dry-run'], {
	cwd,
	env: { ...baseEnv, POST_DRY_RUN: '1' },
	stdio: 'inherit',
});
