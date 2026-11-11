# ai-stack

One health check and repair command for the three tools this machine's Claude Code setup depends on:

| Tool | What it does here | Where it lives |
|------|-------------------|----------------|
| [OmniRoute](https://github.com/diegosouzapw/OmniRoute) | Local model router on `127.0.0.1:20128`; Claude Code falls back to it when the Claude account is out of usage | global npm install, `~/.omniroute`, scheduled tasks `OmniRoute` and `OmniRoute-Watchdog` |
| [Ultron](https://github.com/saiswaroopkakuru/ultron) | Prunes tool output through two hooks and serves an MCP server | `Projects\ultron` (editable pip install) |
| [ClearBrief](https://github.com/saiswaroopkakuru/clearbrief) | Claude Code plugin and `clearbrief-slim` output filter | plugin `clearbrief@clearbrief-local` |

The three codebases stay separate. This repo only checks that they are installed, wired into Claude Code, and answering.

## Use

```powershell
ai-stack doctor          # check everything; exit code 1 if any check fails
ai-stack doctor --live   # also send one small chat request through OmniRoute (spends a model call)
ai-stack fix             # repair what doctor found, then check again
```

### Save tokens: `slim`

```powershell
npm test 2>&1 | ai-stack slim
```

`slim` reads text on stdin, runs it through both `clearbrief-slim` and `ultron compress`, and prints whichever result is shortest. If neither tool makes the text shorter, or both fail, it prints the original unchanged, so piping through it never loses output. One size line goes to stderr, for example `ai-stack slim: 33659 -> 96 chars (clearbrief)`. The two tools are good at different input: ClearBrief also cuts logs where every line differs, Ultron cuts repeated lines and JSON and leaves a breadcrumb for `ultron expand`.

Run from a checkout with `node ai-stack.mjs doctor`, or run `npm link` once to get the `ai-stack` command everywhere. Needs Node 20 or newer; there are no dependencies.

## What doctor checks

- **OmniRoute:** CLI on PATH, port 20128 accepts connections, `/api/health` returns 200, `~/.claude/omniroute-settings.json` points at the router, the fallback token is accepted by `/v1/models`, both scheduled tasks exist.
- **Ultron:** CLI on PATH, both hook scripts exist and are registered in `~/.claude/settings.json`, and the MCP entry in `~/.claude.json` answers a real `initialize` request when started exactly as configured.
- **ClearBrief:** CLI on PATH, plugin enabled, plugin MCP server answers `initialize`.
- **Together:** a repetitive build log with one error line is shrunk by both `clearbrief-slim` and `ultron compress`.

## What fix repairs

| Failure | Repair |
|---------|--------|
| Port 20128 closed | Runs `~/.omniroute/watchdog.ps1` and waits up to 60 seconds |
| Ultron hooks missing or unregistered | Runs `ultron install` |
| Ultron MCP server does not answer | Tries the Ultron checkout's `.venv` Python, then the default `python`, then `ultron mcp`; writes the first one that answers into `~/.claude.json` |

Before editing `~/.claude.json`, fix copies it to `~/.claude.json.ai-stack-<timestamp>.bak`. Restart Claude Code after that repair. Fix never prints or changes API keys. Failures with no repair listed (for example a missing scheduled task) are reported and left alone.

## Known cause: Ultron and `mcp` 2.x

Ultron 1.0.0 pins `mcp<2` and imports `mcp.server.fastmcp`. When the shared Python also has `markitdown-mcp`, pip installs `mcp` 2.x and Ultron's server exits with `ModuleNotFoundError: No module named 'mcp.server.fastmcp'`. Running the server from Ultron's own `.venv` keeps the two apart, which is what `fix` sets up.

## Not covered

- Ultron and ClearBrief both compress tool output through hooks. Doctor does not decide which one should run on which tool.
- `ultron start` (Ultron's own gateway proxy) is not used or checked.
- Windows only: it relies on `schtasks`, PowerShell and this machine's paths.

## Tests

```powershell
npm test
```

Unit tests cover the TCP probe, the MCP handshake (success, early exit, missing command, timeout), hook detection and plugin-version selection. They start small real processes and sockets; nothing is mocked.
