#!/usr/bin/env node
// ai-stack: one health check and repair command for OmniRoute, Ultron and ClearBrief
// as they are wired into Claude Code on this Windows machine.
//   ai-stack doctor [--live]   check everything; exit 1 if anything fails
//   ai-stack fix [--live]      repair what doctor found, then check again
//   <command> | ai-stack slim  print the smallest of: raw, ClearBrief, Ultron
import { readFileSync, writeFileSync, copyFileSync, existsSync, readdirSync, mkdtempSync, realpathSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const HOME = os.homedir();
const OMNI_HOST = '127.0.0.1';
const OMNI_PORT = 20128;
const OMNI_URL = `http://${OMNI_HOST}:${OMNI_PORT}`;
const FILES = {
  claudeJson: path.join(HOME, '.claude.json'),
  settings: path.join(HOME, '.claude', 'settings.json'),
  omniSettings: path.join(HOME, '.claude', 'omniroute-settings.json'),
  watchdog: path.join(HOME, '.omniroute', 'watchdog.ps1'),
  hooksDir: path.join(HOME, '.claude', 'scripts', 'hooks'),
  clearbriefCache: path.join(HOME, '.claude', 'plugins', 'cache', 'clearbrief-local', 'clearbrief'),
};
const ULTRON_HOOKS = ['ultron-pre-tool.py', 'ultron-post-tool.py'];
const CLEARBRIEF_PLUGIN = 'clearbrief@clearbrief-local';

export function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'));
}

/** True when something accepts a TCP connection on host:port. */
export function tcpOpen(host, port, timeoutMs = 3000) {
  return new Promise(resolve => {
    const socket = net.connect({ host, port });
    const done = ok => { socket.destroy(); resolve(ok); };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
}

/** HTTP status of a request, or 0 when the request itself fails. */
export async function httpStatus(url, init = {}) {
  try {
    const res = await fetch(url, { ...init, signal: AbortSignal.timeout(init.timeoutMs ?? 10000) });
    await res.arrayBuffer();
    return res.status;
  } catch {
    return 0;
  }
}

/**
 * Start an MCP stdio server and send `initialize`. Resolves { ok, detail }.
 * ok means the server answered request id 1 with a result.
 */
export function mcpHandshake({ command, args = [], env = {}, cwd = HOME }, timeoutMs = 20000) {
  return new Promise(resolve => {
    let child;
    try {
      child = spawn(command, args, { cwd, env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    } catch (err) {
      resolve({ ok: false, detail: `spawn failed: ${err.message}` });
      return;
    }
    let out = '';
    let errText = '';
    let settled = false;
    const finish = result => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill();
      resolve(result);
    };
    const timer = setTimeout(() => finish({ ok: false, detail: `no initialize response in ${timeoutMs / 1000}s` }), timeoutMs);
    child.once('error', err => finish({ ok: false, detail: `spawn failed: ${err.message}` }));
    child.once('exit', code => finish({ ok: false, detail: `exited with code ${code} before answering: ${errText.trim().split('\n').pop() || 'no stderr'}` }));
    child.stderr.on('data', chunk => { errText += chunk; });
    child.stdout.on('data', chunk => {
      out += chunk;
      for (const line of out.split('\n')) {
        let msg;
        try { msg = JSON.parse(line); } catch { continue; }
        if (msg.id === 1 && msg.result) {
          finish({ ok: true, detail: `${msg.result.serverInfo?.name ?? 'server'} ${msg.result.serverInfo?.version ?? ''}`.trim() });
        } else if (msg.id === 1 && msg.error) {
          finish({ ok: false, detail: `initialize error: ${msg.error.message}` });
        }
      }
    });
    child.stdin.on('error', () => {});
    child.stdin.write(JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'ai-stack', version: '1.0.0' } },
    }) + '\n');
  });
}

/** Which Ultron hook scripts are registered in a Claude Code settings object. */
export function registeredUltronHooks(settings) {
  const commands = Object.values(settings?.hooks ?? {})
    .flat()
    .flatMap(group => group?.hooks ?? [])
    .map(hook => hook?.command ?? '');
  return ULTRON_HOOKS.filter(name => commands.some(command => command.includes(name)));
}

/** Path of the newest installed ClearBrief plugin server, or null. */
export function clearbriefServer(cacheDir = FILES.clearbriefCache) {
  if (!existsSync(cacheDir)) return null;
  const versions = readdirSync(cacheDir).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  for (const version of versions.reverse()) {
    const server = path.join(cacheDir, version, 'src', 'server.js');
    if (existsSync(server)) return server;
  }
  return null;
}

/** Run a fixed shell command (never built from untrusted input). */
function sh(command, { input, timeoutMs = 60000 } = {}) {
  const r = spawnSync(command, { shell: true, input, encoding: 'utf8', timeout: timeoutMs, windowsHide: true });
  return { code: r.status, out: (r.stdout ?? '').trim(), err: (r.stderr ?? '').trim() };
}

/** A noisy build log: one warning repeated 400 times around a single ERROR line. */
function sampleLog() {
  const lines = Array(400).fill('npm warn deprecated inflight@1.0.6: This module is not supported, and leaks memory.');
  lines.splice(250, 0, 'npm ERROR code ELIFECYCLE: build script exited with code 1');
  return lines.join('\n') + '\n';
}

function ultronEntry() {
  return readJson(FILES.claudeJson).mcpServers?.ultron ?? null;
}

async function omniChecks(live) {
  const results = [];
  const add = (name, ok, detail, fix) => results.push({ tool: 'OmniRoute', name, ok, detail, fix });

  const cli = sh('omniroute --version');
  add('CLI on PATH', cli.code === 0, cli.code === 0 ? cli.out.split('\n')[0] : 'omniroute command not found');

  const up = await tcpOpen(OMNI_HOST, OMNI_PORT);
  add(`port ${OMNI_PORT} accepts connections`, up, up ? 'listening' : 'nothing listening', 'omni-start');

  const health = up ? await httpStatus(`${OMNI_URL}/api/health`) : 0;
  add('health endpoint', health === 200, `GET /api/health -> ${health || 'no response'}`);

  let env = {};
  let settingsOk = false;
  try {
    env = readJson(FILES.omniSettings).env ?? {};
    settingsOk = env.ANTHROPIC_BASE_URL === OMNI_URL;
    add('Claude fallback settings', settingsOk, settingsOk ? `ANTHROPIC_BASE_URL = ${OMNI_URL}, model ${env.ANTHROPIC_MODEL}` : `ANTHROPIC_BASE_URL is ${env.ANTHROPIC_BASE_URL ?? 'unset'}, expected ${OMNI_URL}`);
  } catch (err) {
    add('Claude fallback settings', false, `cannot read ${FILES.omniSettings}: ${err.message}`);
  }

  const token = env.ANTHROPIC_AUTH_TOKEN;
  const headers = token ? { 'x-api-key': token, authorization: `Bearer ${token}`, 'anthropic-version': '2023-06-01' } : {};
  const models = up && token ? await httpStatus(`${OMNI_URL}/v1/models`, { headers }) : 0;
  add('fallback token accepted', models === 200, token ? `GET /v1/models -> ${models || 'no response'}` : 'no ANTHROPIC_AUTH_TOKEN in fallback settings');

  for (const task of ['OmniRoute', 'OmniRoute-Watchdog']) {
    const q = sh(`schtasks /Query /TN "${task}" /FO CSV /NH`);
    add(`scheduled task ${task}`, q.code === 0, q.code === 0 ? q.out.split(',').pop().replaceAll('"', '') : 'task not found');
  }

  if (live) {
    const status = up && token ? await httpStatus(`${OMNI_URL}/v1/messages`, {
      method: 'POST', timeoutMs: 60000,
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({ model: env.ANTHROPIC_MODEL, max_tokens: 16, messages: [{ role: 'user', content: 'Reply with the single word OK.' }] }),
    }) : 0;
    add('live model call', status === 200, `POST /v1/messages (${env.ANTHROPIC_MODEL}) -> ${status || 'no response'}`);
  }
  return results;
}

async function ultronChecks() {
  const results = [];
  const add = (name, ok, detail, fix) => results.push({ tool: 'Ultron', name, ok, detail, fix });

  let entry = null;
  try { entry = ultronEntry(); } catch (err) { add('MCP entry', false, `cannot read ${FILES.claudeJson}: ${err.message}`); }

  const cli = sh('ultron --help');
  add('CLI on PATH', cli.code === 0, cli.code === 0 ? 'ultron command runs' : 'ultron command not found');

  const missingFiles = ULTRON_HOOKS.filter(name => !existsSync(path.join(FILES.hooksDir, name)));
  let registered = [];
  try { registered = registeredUltronHooks(readJson(FILES.settings)); } catch { /* reported below as unregistered */ }
  const unregistered = ULTRON_HOOKS.filter(name => !registered.includes(name));
  const hooksOk = missingFiles.length === 0 && unregistered.length === 0;
  add('hooks installed and registered', hooksOk,
    hooksOk ? ULTRON_HOOKS.join(', ') : [missingFiles.length && `missing files: ${missingFiles.join(', ')}`, unregistered.length && `not in settings.json: ${unregistered.join(', ')}`].filter(Boolean).join('; '),
    'ultron-install');

  if (entry) {
    const shake = await mcpHandshake(entry);
    add('MCP server answers initialize', shake.ok, shake.ok ? shake.detail : `${entry.command} ${(entry.args ?? []).join(' ')}: ${shake.detail}`, 'ultron-mcp');
  } else if (!results.some(r => r.name === 'MCP entry')) {
    add('MCP server answers initialize', false, 'no mcpServers.ultron entry in ~/.claude.json', 'ultron-mcp');
  }
  return results;
}

async function clearbriefChecks() {
  const results = [];
  const add = (name, ok, detail) => results.push({ tool: 'ClearBrief', name, ok, detail });

  const cli = sh('clearbrief --version');
  add('CLI on PATH', cli.code === 0, cli.code === 0 ? cli.out.split('\n')[0] || 'clearbrief command runs' : 'clearbrief command not found');

  let enabled = false;
  try { enabled = readJson(FILES.settings).enabledPlugins?.[CLEARBRIEF_PLUGIN] === true; } catch { /* falls through as not enabled */ }
  add('plugin enabled', enabled, enabled ? CLEARBRIEF_PLUGIN : `${CLEARBRIEF_PLUGIN} is not enabled in settings.json`);

  const server = clearbriefServer();
  if (server) {
    const shake = await mcpHandshake({ command: process.execPath, args: [server], env: { CLAUDE_PLUGIN_ROOT: path.dirname(path.dirname(server)) } });
    add('MCP server answers initialize', shake.ok, shake.detail);
  } else {
    add('MCP server answers initialize', false, `no src/server.js under ${FILES.clearbriefCache}`);
  }
  return results;
}

function togetherChecks() {
  const results = [];
  const add = (name, ok, detail) => results.push({ tool: 'Together', name, ok, detail });
  const log = sampleLog();

  const slim = sh('clearbrief-slim', { input: log });
  const slimOk = slim.code === 0 && slim.out.length > 0 && slim.out.length < log.length;
  add('clearbrief-slim shrinks a sample log', slimOk, slim.code === 0 ? `${log.length} -> ${slim.out.length} chars${slim.out.includes('ERROR') ? ', ERROR line kept' : ', ERROR line NOT kept'}` : `exit ${slim.code}: ${slim.err.split('\n').pop()}`);

  const file = path.join(mkdtempSync(path.join(os.tmpdir(), 'ai-stack-')), 'sample.log');
  writeFileSync(file, log);
  const comp = sh(`ultron compress "${file}"`);
  const compOk = comp.code === 0 && comp.out.length > 0 && comp.out.length < log.length;
  add('ultron compress shrinks a sample log', compOk, comp.code === 0 ? `${log.length} -> ${comp.out.length} chars` : `exit ${comp.code}: ${comp.err.split('\n').pop()}`);
  return results;
}

/**
 * Choose what to print for `slim`: the shortest non-empty candidate that is
 * strictly shorter than the input, otherwise the input itself as "raw".
 */
export function pickSmallest(input, candidates) {
  let best = { name: 'raw', text: input };
  for (const { name, text } of candidates) {
    if (text && text.length < best.text.length) best = { name, text };
  }
  return best;
}

/** Compress text with ClearBrief and Ultron; a tool that fails contributes nothing. */
function compressWithBoth(input) {
  const candidates = [];
  const slim = sh('clearbrief-slim', { input });
  if (slim.code === 0) candidates.push({ name: 'clearbrief', text: slim.out });

  const file = path.join(mkdtempSync(path.join(os.tmpdir(), 'ai-stack-')), 'input.txt');
  writeFileSync(file, input);
  const comp = sh(`ultron compress "${file}"`);
  if (comp.code === 0) candidates.push({ name: 'ultron', text: comp.out });
  return candidates;
}

/** `ai-stack slim`: stdin in, smallest version out. The size line goes to stderr. */
function slimCommand() {
  if (process.stdin.isTTY) {
    console.error('Usage: <command> | ai-stack slim');
    return 2;
  }
  const input = readFileSync(0, 'utf8');
  const best = pickSmallest(input, compressWithBoth(input));
  process.stdout.write(best.text.endsWith('\n') || !best.text ? best.text : best.text + '\n');
  console.error(`ai-stack slim: ${input.length} -> ${best.text.length} chars (${best.name})`);
  return 0;
}

export async function runChecks({ live = false } = {}) {
  return [...await omniChecks(live), ...await ultronChecks(), ...await clearbriefChecks(), ...togetherChecks()];
}

function backup(file) {
  const copy = `${file}.ai-stack-${new Date().toISOString().replace(/[:.]/g, '-')}.bak`;
  copyFileSync(file, copy);
  return copy;
}

const FIXES = {
  async 'omni-start'() {
    if (!existsSync(FILES.watchdog)) return `cannot start OmniRoute: ${FILES.watchdog} is missing`;
    sh(`powershell -NoProfile -ExecutionPolicy Bypass -File "${FILES.watchdog}"`, { timeoutMs: 120000 });
    for (let i = 0; i < 30; i++) {
      if (await tcpOpen(OMNI_HOST, OMNI_PORT)) return `started OmniRoute through watchdog.ps1`;
      await new Promise(r => setTimeout(r, 2000));
    }
    return 'ran watchdog.ps1 but port 20128 is still closed after 60s';
  },
  async 'ultron-install'() {
    const r = sh('ultron install');
    return r.code === 0 ? 'ran `ultron install`' : `\`ultron install\` failed: ${r.err.split('\n').pop()}`;
  },
  async 'ultron-mcp'() {
    const python = sh('python -c "import sys;print(sys.executable)"');
    // Ultron pins mcp<2. A shared Python can carry mcp 2.x for other servers, so prefer
    // the interpreter in the Ultron checkout's own .venv when it exists.
    const repo = sh('python -c "import ultron,os;print(os.path.dirname(os.path.dirname(ultron.__file__)))"');
    const venvPython = repo.code === 0 ? path.join(repo.out, '.venv', 'Scripts', 'python.exe') : '';
    const candidates = [
      existsSync(venvPython) && { command: venvPython, args: ['-m', 'ultron.cli', 'mcp'], env: { PYTHONUNBUFFERED: '1' } },
      python.code === 0 && { command: python.out, args: ['-m', 'ultron.cli', 'mcp'], env: { PYTHONUNBUFFERED: '1' } },
      { command: 'ultron', args: ['mcp'], env: { PYTHONUNBUFFERED: '1' } },
    ].filter(Boolean);
    for (const candidate of candidates) {
      if (!(await mcpHandshake(candidate)).ok) continue;
      const copy = backup(FILES.claudeJson);
      const config = readJson(FILES.claudeJson); // re-read right before writing: Claude Code rewrites this file
      config.mcpServers = { ...config.mcpServers, ultron: { ...config.mcpServers?.ultron, type: config.mcpServers?.ultron?.type ?? 'stdio', ...candidate } };
      writeFileSync(FILES.claudeJson, JSON.stringify(config, null, 2));
      return `rewrote mcpServers.ultron to \`${candidate.command} ${candidate.args.join(' ')}\` (backup: ${copy}); restart Claude Code to pick it up`;
    }
    return 'no working way to start the Ultron MCP server was found; is ultron-claude installed for `python`?';
  },
};

function print(results) {
  let tool = '';
  for (const r of results) {
    if (r.tool !== tool) { tool = r.tool; console.log(`\n${tool}`); }
    console.log(`  ${r.ok ? 'PASS' : 'FAIL'}  ${r.name}: ${r.detail}`);
  }
  const failed = results.filter(r => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed.`);
  return failed;
}

async function main(argv) {
  const command = argv.find(a => !a.startsWith('-')) ?? 'doctor';
  const live = argv.includes('--live');
  if (command === 'slim') return slimCommand();
  if (!['doctor', 'fix'].includes(command)) {
    console.error('Usage: ai-stack <doctor|fix> [--live]\n       <command> | ai-stack slim');
    return 2;
  }
  let failed = print(await runChecks({ live }));
  if (command === 'fix' && failed.length) {
    const ids = [...new Set(failed.map(r => r.fix).filter(Boolean))];
    if (!ids.length) console.log('\nNo automatic fix exists for the failures above.');
    for (const id of ids) console.log(`\nfix ${id}: ${await FIXES[id]()}`);
    if (ids.length) failed = print(await runChecks({ live }));
  }
  return failed.length ? 1 : 0;
}

// realpath: `npm link` runs this file through a symlink, so argv[1] is not its real location.
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  process.exitCode = await main(process.argv.slice(2));
}
