'use strict';

/**
 * E2E-F6: create or update a single GitHub Issue for an auto-release failure.
 *
 * Modes:
 *   --plan-only   print notice JSON (no network)
 *   --execute     upsert issue via gh (requires GH_TOKEN)
 *
 * Dedupes open issues by label + correlationId (preferred) or
 * repo+stage+resourceVersion fingerprint.
 */

const { spawnSync } = require('node:child_process');

const LABEL = 'moeicons-auto-release-failure';

function arg(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function hasFlag(name) {
  return process.argv.includes(name);
}

function requireText(name, value) {
  const text = String(value || '').trim();
  if (!text) throw new Error(`${name} required`);
  return text;
}

function buildFailureNotice(input) {
  const repo = requireText('repo', input.repo);
  const runUrl = requireText('runUrl', input.runUrl);
  const stage = requireText('stage', input.stage);
  const resourceVersion = String(input.resourceVersion || 'n/a').trim() || 'n/a';
  const correlationId = String(input.correlationId || '').trim();
  const attempt = String(input.attempt || '1').trim() || '1';
  const conclusion = String(input.conclusion || 'failure').trim() || 'failure';
  const fingerprint = correlationId
    ? `correlation:${correlationId}`
    : `fingerprint:${repo}|${stage}|${resourceVersion}`;

  const title = correlationId
    ? `[auto-release] ${repo} ${stage} ${correlationId}`
    : `[auto-release] ${repo} ${stage} ${resourceVersion}`;

  const body = [
    '## Auto-release failure',
    '',
    `- repository: \`${repo}\``,
    `- stage: \`${stage}\``,
    `- resourceVersion: \`${resourceVersion}\``,
    `- attempt: \`${attempt}\``,
    `- conclusion: \`${conclusion}\``,
    correlationId ? `- correlationId: \`${correlationId}\`` : null,
    `- run: ${runUrl}`,
    `- fingerprint: \`${fingerprint}\``,
    '',
    'This issue is the unique visible notification for this failure stage.',
    'Successful runs must not open noise issues. Re-runs should update this',
    'issue rather than creating duplicates for the same fingerprint.',
    '',
    `<!-- moeicons-failure-fingerprint:${fingerprint} -->`,
  ]
    .filter(Boolean)
    .join('\n');

  return {
    label: LABEL,
    title,
    body,
    fingerprint,
    repo,
    stage,
    resourceVersion,
    correlationId: correlationId || null,
    runUrl,
    attempt,
    conclusion,
  };
}

function matchExistingIssue(issues, notice) {
  const open = (issues || []).filter((issue) => issue.state === 'open');
  const marker = `<!-- moeicons-failure-fingerprint:${notice.fingerprint} -->`;
  const hits = open.filter((issue) => {
    const body = String(issue.body || '');
    const title = String(issue.title || '');
    return body.includes(marker) || title === notice.title;
  });
  if (hits.length === 0) return null;
  if (hits.length > 1) {
    throw new Error(
      `ambiguous failure issues for ${notice.fingerprint}: ${hits.map((h) => h.number).join(',')}`,
    );
  }
  return hits[0];
}

function ghJson(args, token) {
  const result = spawnSync('gh', args, {
    encoding: 'utf8',
    env: { ...process.env, GH_TOKEN: token, GH_PROMPT_DISABLED: '1' },
  });
  if (result.status !== 0) {
    throw new Error(`gh ${args.join(' ')} failed:\n${result.stderr || result.stdout}`);
  }
  const out = (result.stdout || '').trim();
  return out ? JSON.parse(out) : null;
}

function ensureLabel(token, repo) {
  const labels = ghJson(['label', 'list', '--repo', repo, '--json', 'name'], token) || [];
  if (labels.some((l) => l.name === LABEL)) return;
  spawnSync(
    'gh',
    ['label', 'create', LABEL, '--repo', repo, '--color', 'B60205', '--description', 'Unique auto-release failure notification'],
    { encoding: 'utf8', env: { ...process.env, GH_TOKEN: token, GH_PROMPT_DISABLED: '1' } },
  );
}

function createFailureIssue(notice, options) {
  const token = options.token;
  if (!token) throw new Error('GH_TOKEN required');
  const targetRepo = options.issueRepo || notice.repo;
  ensureLabel(token, targetRepo);

  const issues =
    ghJson(
      [
        'issue',
        'list',
        '--repo',
        targetRepo,
        '--label',
        LABEL,
        '--state',
        'open',
        '--limit',
        '50',
        '--json',
        'number,title,body,url,state',
      ],
      token,
    ) || [];

  const existing = matchExistingIssue(issues, notice);
  if (existing) {
    const comment = [
      '### Re-reported failure',
      '',
      `- run: ${notice.runUrl}`,
      `- attempt: \`${notice.attempt}\``,
      `- conclusion: \`${notice.conclusion}\``,
      `- stage: \`${notice.stage}\``,
    ].join('\n');
    const result = spawnSync(
      'gh',
      ['issue', 'comment', String(existing.number), '--repo', targetRepo, '--body', comment],
      { encoding: 'utf8', env: { ...process.env, GH_TOKEN: token, GH_PROMPT_DISABLED: '1' } },
    );
    if (result.status !== 0) {
      throw new Error(`issue comment failed:\n${result.stderr || result.stdout}`);
    }
    return { action: 'commented', number: existing.number, url: existing.url, notice };
  }

  const result = spawnSync(
    'gh',
    [
      'issue',
      'create',
      '--repo',
      targetRepo,
      '--title',
      notice.title,
      '--label',
      LABEL,
      '--body',
      notice.body,
    ],
    { encoding: 'utf8', env: { ...process.env, GH_TOKEN: token, GH_PROMPT_DISABLED: '1' } },
  );
  if (result.status !== 0) {
    throw new Error(`issue create failed:\n${result.stderr || result.stdout}`);
  }
  const url = (result.stdout || '').trim();
  return { action: 'created', url, notice };
}

function main() {
  const planOnly = hasFlag('--plan-only');
  const execute = hasFlag('--execute');
  if (planOnly === execute) throw new Error('specify exactly one of --plan-only or --execute');

  const notice = buildFailureNotice({
    repo: arg('--repo'),
    runUrl: arg('--run-url'),
    stage: arg('--stage'),
    resourceVersion: arg('--resource-version'),
    correlationId: arg('--correlation-id'),
    attempt: arg('--attempt'),
    conclusion: arg('--conclusion'),
  });

  if (planOnly) {
    process.stdout.write(`${JSON.stringify(notice, null, 2)}\n`);
    return;
  }

  const report = createFailureIssue(notice, {
    token: process.env.GH_TOKEN || process.env.GITHUB_TOKEN,
    issueRepo: arg('--issue-repo') || notice.repo,
  });
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

module.exports = {
  LABEL,
  buildFailureNotice,
  matchExistingIssue,
  createFailureIssue,
};

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
}
