# gdgraph MCP Installer

`gdgraph install` writes MCP server configuration for supported Agent clients.

Install the current public source build first:

```bash
git clone https://github.com/biubiuHui/godot-agent-graph.git
cd godot-agent-graph
npm install
npm run build
npm install -g .
```

After the package is published to npm, this can be replaced with:

```bash
npm install -g godot-agent-graph
```

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
gdgraph install --target codex --with-skill
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
| `codex` | `~/.codex/config.toml` plus an owned project `AGENTS.md` fallback instruction block |
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

For Codex, install also manages a short project `AGENTS.md` block:

```markdown
<!-- godot-agent-graph:begin codex-instructions -->
## Godot Graph Navigation

- For Godot scripts, scenes, resources, signals, autoloads, node paths, or call chains, use MCP tool `godot_context` before broad file search.
- For `godot_context.query`, use terse identifier-heavy keyword queries: exact class names, method names, constants, fields, resource paths, file/path fragments, and domain nouns.
- For `.tres` resource queries, include path fragments and exported/resource property names or string values; treat results as navigation, not exhaustive inventory.
- Do not write natural-language task instructions in `godot_context.query`, such as "find", "include paths", "summarize", "relevant for", or "tell me".
- Use `godot_node` for indexed Godot source reads instead of raw file reads.
- If the graph is stale or missing, use `godot_status` then `godot_sync`; without MCP, run `gdgraph sync <project>`, then `gdgraph context <query> --path <project>`.
- Before edits, refactors, reviews, or debugging changes, use `godot_context` for edit-planning and bounded relationship context.
- Treat `godot_context.truncated` and `godot_node.notes.omitted` as signs that the graph returned a bounded navigation summary, not exhaustive proof; use a narrow `rg` or tests for constants, enums, signal names, resource paths, and string protocols.
<!-- godot-agent-graph:end codex-instructions -->
```

The installer replaces or removes only this marked instruction block.

By default, Codex install does not copy the repository skill. To install the optional global Codex skill as well, run:

```bash
gdgraph install /path/to/project --target codex --with-skill
```

This writes:

```text
~/.codex/skills/godot-graph-navigation/
```

When `--home` is provided, the skill is written under that home directory's `.codex/skills` folder. If that skill path already exists and differs from the bundled gdgraph skill, install preserves the existing directory instead of overwriting it.

Use the matching uninstall flag to remove it:

```bash
gdgraph uninstall /path/to/project --target codex --with-skill
```

Uninstall removes the global skill only when it still exactly matches the bundled generated skill. User-modified skill files are preserved.

To stop using gdgraph for a project completely, remove Agent configuration, remove local graph data, then uninstall the global package:

```bash
gdgraph uninstall /path/to/project --target codex --with-skill
gdgraph clean /path/to/project
npm uninstall -g godot-agent-graph
```

`uninstall` removes gdgraph-owned Agent configuration. `clean` removes the project-local `.gdgraph` index data.

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
