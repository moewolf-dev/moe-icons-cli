#!/usr/bin/env node
// Invoke the installed executable, not imported server mocks. Resource integration
// requires an explicitly supplied verified fixture/release environment.
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
const bin = resolve(process.argv[2] ?? 'bin/moeicons.js');
const root = mkdtempSync(join(tmpdir(), 'moeicons-packed-mcp-'));
mkdirSync(join(root, 'src'));
writeFileSync(join(root, 'package.json'), JSON.stringify({ dependencies: { vue: '^3', vite: '^5' } }));
writeFileSync(join(root, 'package-lock.json'), '{}');
writeFileSync(join(root, 'src/main.ts'), "import { createApp } from 'vue'; import App from './App.vue'; createApp(App).mount('#app');\n");
writeFileSync(join(root, 'src/App.vue'), '<template><div>App</div></template>');
const child = spawn(process.execPath, [bin, 'mcp'], { cwd: root, env: process.env, stdio: ['pipe', 'pipe', 'pipe'] });
const pending = new Map(); let buffer = '', id = 0, stderrBytes = 0;
child.stderr.on('data', (chunk) => { stderrBytes += chunk.length; });
child.stdout.on('data', (chunk) => {
  buffer += chunk;
  while (buffer.includes('\n')) {
    const offset = buffer.indexOf('\n'), line = buffer.slice(0, offset); buffer = buffer.slice(offset + 1);
    try { const response = JSON.parse(line); pending.get(response.id)?.resolve(response); }
    catch { for (const item of pending.values()) item.reject(new Error('stdout contained non-JSON output')); }
  }
});
child.on('error', (error) => { for (const item of pending.values()) item.reject(error); });
child.on('exit', () => { for (const item of pending.values()) item.reject(new Error('server exited before response')); });
async function request(method, params) {
  const requestId = ++id;
  const response = await new Promise((resolveResponse, reject) => {
    const timeout = setTimeout(() => reject(new Error(`timeout: ${method}`)), 60000);
    pending.set(requestId, { resolve: (value) => { clearTimeout(timeout); resolveResponse(value); }, reject: (error) => { clearTimeout(timeout); reject(error); } });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: requestId, method, params }) + '\n');
  });
  pending.delete(requestId);
  if (response.error) throw new Error(`${method}: ${response.error.code}`);
  return response.result;
}
async function tool(name, args = {}) {
  const result = await request('tools/call', { name, arguments: args });
  if (result.isError) throw new Error(`tool failed: ${name}`);
  return JSON.parse(result.content[0].text);
}
try {
  await request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'packed-smoke', version: '1' } });
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
  await request('ping');
  const tools = await request('tools/list');
  await tool('init_config', { target: 'vue' });
  await tool('get_usage_guide', { target: 'vue' });
  await tool('find_icons', { query: 'arrow-bold-right', styleGroups: ['moe-outline'] });
  const config = await tool('get_project_config');
  await tool('update_config', { expectedHash: config.hash, patch: { icons: { add: ['arrow-bold-right'], remove: ['ui-search'] } } });
  let resourceFlow = 'not-run';
  if (process.env.MOEICONS_FREE_RELEASE_DIR) {
    await tool('install', { tier: 'free' }); await tool('generate');
    if (!existsSync(join(root, 'src/moeicons/icons/ArrowBoldRight.ts'))) throw new Error('generated proxy missing');
    const current = await tool('get_project_config');
    await tool('update_config', { expectedHash: current.hash, patch: { icons: { remove: ['arrow-bold-right'], add: ['ui-search'] } } });
    await tool('update'); await tool('generate');
    if (existsSync(join(root, 'src/moeicons/icons/ArrowBoldRight.ts')) || !existsSync(join(root, 'src/moeicons/icons/UiSearch.ts'))) throw new Error('selection reconciliation failed');
    resourceFlow = 'passed';
  }
  const hash = createHash('sha256').update(readFileSync(join(root, 'moeicons.config.jsonc'))).digest('hex');
  process.stdout.write(JSON.stringify({ ok: true, transport: 'packed-process-stdio', tools: tools.tools.map((entry) => entry.name), resourceFlow, configHash: hash, stderrBytes }) + '\n');
} finally {
  child.stdin.end(); child.kill('SIGTERM'); rmSync(root, { recursive: true, force: true });
}
