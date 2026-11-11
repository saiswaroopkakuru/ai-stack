import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tcpOpen, mcpHandshake, registeredUltronHooks, clearbriefServer, pickSmallest } from './ai-stack.mjs';

test('pickSmallest returns the shortest candidate that beats the input', () => {
  const input = 'x'.repeat(100);
  assert.deepEqual(pickSmallest(input, [{ name: 'clearbrief', text: 'x'.repeat(40) }, { name: 'ultron', text: 'x'.repeat(10) }]), { name: 'ultron', text: 'x'.repeat(10) });
});

test('pickSmallest keeps the raw input when no candidate is shorter, empty, or present', () => {
  const input = 'short';
  assert.deepEqual(pickSmallest(input, [{ name: 'ultron', text: '[ULTRON] Pruned 0.0%\nshort' }]), { name: 'raw', text: input });
  assert.deepEqual(pickSmallest(input, [{ name: 'clearbrief', text: '' }]), { name: 'raw', text: input });
  assert.deepEqual(pickSmallest(input, []), { name: 'raw', text: input });
});

const FAKE_MCP = `
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => {
  const msg = JSON.parse(chunk.trim().split('\\n')[0]);
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '2024-11-05', capabilities: {}, serverInfo: { name: 'fake', version: '9.9.9' } } }) + '\\n');
});
`;

test('tcpOpen is true for a listening port and false once it closes', async () => {
  const server = net.createServer().listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const { port } = server.address();
  assert.equal(await tcpOpen('127.0.0.1', port, 1000), true);
  await new Promise(resolve => server.close(resolve));
  assert.equal(await tcpOpen('127.0.0.1', port, 1000), false);
});

test('mcpHandshake passes when the server answers initialize', async () => {
  const result = await mcpHandshake({ command: process.execPath, args: ['-e', FAKE_MCP] }, 10000);
  assert.deepEqual(result, { ok: true, detail: 'fake 9.9.9' });
});

test('mcpHandshake fails with the exit code when the server dies first', async () => {
  const result = await mcpHandshake({ command: process.execPath, args: ['-e', 'console.error("boom"); process.exit(3)'] }, 10000);
  assert.equal(result.ok, false);
  assert.match(result.detail, /exited with code 3 .*boom/);
});

test('mcpHandshake fails when the command does not exist', async () => {
  const result = await mcpHandshake({ command: 'definitely-not-a-real-command-xyz' }, 5000);
  assert.equal(result.ok, false);
  assert.match(result.detail, /spawn failed/);
});

test('mcpHandshake times out on a silent server', async () => {
  const result = await mcpHandshake({ command: process.execPath, args: ['-e', 'setInterval(() => {}, 1000)'] }, 500);
  assert.deepEqual(result, { ok: false, detail: 'no initialize response in 0.5s' });
});

test('registeredUltronHooks finds only the hook scripts present in settings', () => {
  const settings = {
    hooks: {
      PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'python "C:/x/ultron-pre-tool.py"' }] }],
      PostToolUse: [{ matcher: 'Read', hooks: [{ type: 'command', command: 'node other.js' }] }],
    },
  };
  assert.deepEqual(registeredUltronHooks(settings), ['ultron-pre-tool.py']);
  assert.deepEqual(registeredUltronHooks({}), []);
});

test('clearbriefServer picks the newest version that has a server file', () => {
  const cache = mkdtempSync(path.join(os.tmpdir(), 'ai-stack-test-'));
  for (const version of ['1.2.0', '1.10.0', '2.0.0']) mkdirSync(path.join(cache, version, 'src'), { recursive: true });
  writeFileSync(path.join(cache, '1.2.0', 'src', 'server.js'), '');
  writeFileSync(path.join(cache, '1.10.0', 'src', 'server.js'), '');
  assert.equal(clearbriefServer(cache), path.join(cache, '1.10.0', 'src', 'server.js'));
  assert.equal(clearbriefServer(path.join(cache, 'missing')), null);
});
