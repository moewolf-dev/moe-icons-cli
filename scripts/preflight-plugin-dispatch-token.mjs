import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const TARGET_REPOSITORY = 'moewolf-dev/moe-icons-plugins';
export const PROBE_EVENT_TYPE = 'moe-icons-resource-permission-probe';

function workflowDispatchBlocks(workflowText) {
  const blocks = [];
  const startPattern = /^  repository_dispatch:\s*$/gm;
  let match;
  while ((match = startPattern.exec(workflowText))) {
    const bodyStart = startPattern.lastIndex;
    const remainder = workflowText.slice(bodyStart);
    const nextEvent = /^  [A-Za-z_][\w-]*:\s*$/m.exec(remainder);
    const body = remainder.slice(0, nextEvent ? nextEvent.index : remainder.length);
    blocks.push(body);
  }
  return blocks;
}

export function assertProbeEventUnhandled(workflows, probeEventType = PROBE_EVENT_TYPE) {
  const listeners = [];
  let receiverFound = false;
  for (const workflow of workflows) {
    const blocks = workflowDispatchBlocks(workflow.text);
    if (workflow.path === '.github/workflows/resource-update.yml' && blocks.length) receiverFound = true;
    for (const block of blocks) {
      if (!/^ {4}types:\s*\S/m.test(block)) {
        throw new Error(`${workflow.path} has an unfiltered repository_dispatch listener`);
      }
      if (block.includes(probeEventType)) {
        throw new Error(`${workflow.path} subscribes to the permission probe event`);
      }
      listeners.push(workflow.path);
    }
  }
  if (!receiverFound) throw new Error('resource-update.yml repository_dispatch receiver was not found');
  if (!listeners.length) throw new Error('target repository has no repository_dispatch listener to verify');
  return { listenerWorkflows: [...new Set(listeners)].sort(), probeEventType };
}

function ghJson(token, args) {
  const stdout = execFileSync('gh', ['api', ...args], {
    encoding: 'utf8',
    env: { ...process.env, GH_TOKEN: token, GITHUB_TOKEN: token, GH_PROMPT_DISABLED: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 8 * 1024 * 1024,
    timeout: 30_000,
  });
  return JSON.parse(stdout || '{}');
}

function main() {
  const token = process.env.PLUGIN_DISPATCH_TOKEN || '';
  if (!token) throw new Error('PLUGIN_DISPATCH_TOKEN is not configured');

  const directory = ghJson(token, [`repos/${TARGET_REPOSITORY}/contents/.github/workflows`]);
  if (!Array.isArray(directory)) throw new Error('target workflow directory could not be read');
  const workflowFiles = directory.filter((entry) => entry.type === 'file' && /\.ya?ml$/i.test(entry.name));
  const workflows = workflowFiles.map((entry) => {
    const content = ghJson(token, [`repos/${TARGET_REPOSITORY}/contents/${entry.path}`]);
    if (typeof content.content !== 'string' || content.encoding !== 'base64') {
      throw new Error(`could not read target workflow ${entry.path}`);
    }
    return { path: entry.path, text: Buffer.from(content.content, 'base64').toString('utf8') };
  });
  const safety = assertProbeEventUnhandled(workflows);
  const metadata = ghJson(token, [`repos/${TARGET_REPOSITORY}`]);
  if (metadata.full_name !== TARGET_REPOSITORY) throw new Error('dispatch token resolved the wrong target repository');

  const event = {
    event_type: PROBE_EVENT_TYPE,
    client_payload: { permissionProbe: true, probeId: `preflight-${process.env.GITHUB_RUN_ID || 'manual'}` },
  };
  execFileSync('gh', ['api', '--method', 'POST', `repos/${TARGET_REPOSITORY}/dispatches`, '--input', '-'], {
    input: JSON.stringify(event),
    encoding: 'utf8',
    env: { ...process.env, GH_TOKEN: token, GITHUB_TOKEN: token, GH_PROMPT_DISABLED: '1' },
    stdio: ['pipe', 'pipe', 'pipe'],
    maxBuffer: 1024 * 1024,
    timeout: 30_000,
  });

  const result = {
    targetRepository: TARGET_REPOSITORY,
    probeEventType: PROBE_EVENT_TYPE,
    subscribedListenerWorkflows: safety.listenerWorkflows,
    dispatchAuthorized: true,
    resourceWorkflowTriggered: false,
  };
  const summary = `## Plugin dispatch token preflight\n\n- Target: \`${result.targetRepository}\`\n- Probe: \`${result.probeEventType}\` (not subscribed by any repository_dispatch workflow)\n- Listeners inspected: ${result.subscribedListenerWorkflows.map((name) => `\`${name}\``).join(', ')}\n- Dispatch permission: verified using the configured \`PLUGIN_DISPATCH_TOKEN\`\n- Resource publication: not triggered\n`;
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    main();
  } catch {
    // Do not print API errors: they can include sensitive request context.
    console.error('Plugin dispatch preflight failed. Check target workflow access and PLUGIN_DISPATCH_TOKEN permissions.');
    process.exit(1);
  }
}
