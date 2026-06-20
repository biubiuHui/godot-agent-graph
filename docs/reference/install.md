# gdgraph MCP Installer

`gdgraph install` writes MCP server configuration for supported Agent clients.

```bash
gdgraph install /path/to/godot/project
gdgraph uninstall /path/to/godot/project
```

By default, the installer writes project-ready MCP configuration for the main local Agent clients:

```bash
gdgraph install --target all
gdgraph install --target codex
gdgraph install --target claude
gdgraph install --target cursor
gdgraph install --target opencode
gdgraph install --target gemini
gdgraph install --target kiro
```

The generated server command is usually:

```bash
gdgraph serve --mcp /path/to/godot/project
```

The explicit project path keeps the MCP server stable when an Agent launches tools from a different working directory.
For Codex, the installer may write an absolute Node command plus the absolute `gdgraph` bin path so the desktop app does not depend on your shell `PATH`.

Supported target ids are:

| Target | Config written |
| --- | --- |
| `codex` | `~/.codex/config.toml` |
| `claude` | `<project>/.mcp.json` |
| `cursor` | `<project>/.cursor/mcp.json` |
| `opencode` | `<project>/opencode.jsonc` or existing `<project>/opencode.json` |
| `gemini` | `<project>/.gemini/settings.json` |
| `kiro` | `<project>/.kiro/settings/mcp.json` |

macOS and Windows users should run `gdgraph install` on their own machine after installing `godot-agent-graph`. User-level Codex config is generated with that machine's Node/bin paths; project-level configs use the portable `gdgraph` command by default.

## Codex

Codex configuration is written to:

```text
~/.codex/config.toml
```

The installer adds an owned block:

```toml
# godot-agent-graph:begin codex
[mcp_servers.godot-agent-graph]
command = "/absolute/path/to/node"
args = ["/absolute/path/to/gdgraph.js", "serve", "--mcp", "/path/to/godot/project"]
enabled = true
startup_timeout_sec = 60
# godot-agent-graph:end codex
```

Uninstall removes only this marked block. If an unmarked `[mcp_servers.godot-agent-graph]` or `[mcp_servers."godot-agent-graph"]` table already exists, install skips it instead of overwriting user configuration.

## Claude Code

Claude Code, Cursor, Gemini, and Kiro use the common `mcpServers` shape. Claude Code project MCP configuration is written to:

```text
/path/to/godot/project/.mcp.json
```

The installer adds:

```json
{
  "mcpServers": {
    "godot-agent-graph": {
      "type": "stdio",
      "command": "gdgraph",
      "args": ["serve", "--mcp", "/path/to/godot/project"]
    }
  }
}
```

Uninstall removes the `godot-agent-graph` entry only when it still exactly matches the generated config. If a user edits that entry, uninstall skips it.

## opencode

opencode uses `mcp` instead of `mcpServers`, and its `command` is an array:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "godot-agent-graph": {
      "type": "local",
      "command": ["gdgraph", "serve", "--mcp", "/path/to/godot/project"],
      "enabled": true
    }
  }
}
```

The installer edits JSONC with comment preservation, so existing `//` and `/* */` comments remain intact.

## Advanced Options

Use `--command` when `gdgraph` is not globally available:

```bash
gdgraph install /path/to/project --command /absolute/path/to/gdgraph
```

Use `--home` to point user-scoped targets such as Codex at a different home directory:

```bash
gdgraph install /path/to/project --target codex --home /tmp/test-home
```
