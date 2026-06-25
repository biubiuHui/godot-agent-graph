# Godot Agent Graph Agent Install Instructions

Use these instructions when a user asks an agent to install `godot-agent-graph` for a Godot project.

## Goal

Install the `gdgraph` CLI, index the user's Godot project, and configure the user's local Agent MCP client so future agents can query Godot scripts, scenes, resources, signal connections, node paths, and static relationships through the graph.

## Safety Rules

- Do not edit the user's Godot game files except for generated Agent configuration that `gdgraph install` owns.
- Do not commit `.gdgraph/`; it is local graph storage.
- Do not copy private project code into public issues, docs, examples, or install notes.
- If the Godot project root is unclear, ask the user for the directory that contains `project.godot`.
- Prefer the current Agent target only. Use `--target all` only when the user explicitly wants every supported client configured.

## Requirements

- Node.js 20 or newer
- npm
- git

Check:

```bash
node --version
npm --version
git --version
```

If Node.js is older than 20 or missing, stop and ask the user to install or upgrade Node.js first.

## Locate The Godot Project

Use the current working directory if it contains `project.godot`.

If not, find or ask for the Godot project root, then set:

```bash
PROJECT_ROOT="/absolute/path/to/godot/project"
```

Verify:

```bash
test -f "$PROJECT_ROOT/project.godot"
```

## Install gdgraph From Source

Until an npm package is published, install from GitHub source:

```bash
TOOLS_DIR="${HOME}/.local/share/gdgraph"
mkdir -p "$TOOLS_DIR"

if [ ! -d "$TOOLS_DIR/godot-agent-graph/.git" ]; then
  git clone https://github.com/biubiuHui/godot-agent-graph.git "$TOOLS_DIR/godot-agent-graph"
fi

cd "$TOOLS_DIR/godot-agent-graph"
git pull
npm install
npm run build
npm install -g .
gdgraph version
```

After an npm package is published, this source install can be replaced with:

```bash
npm install -g godot-agent-graph
```

## Build Or Refresh The Project Index

```bash
gdgraph sync "$PROJECT_ROOT"
gdgraph status "$PROJECT_ROOT"
```

If the index is stale later, use:

```bash
gdgraph sync "$PROJECT_ROOT"
```

Use a full rebuild only when the user asks to discard the existing graph:

```bash
gdgraph sync "$PROJECT_ROOT" --rebuild
```

## Configure The Agent MCP Client

Choose one target:

- Codex: `codex`
- Claude Code: `claude`
- Cursor: `cursor`
- opencode: `opencode`
- Gemini: `gemini`
- Kiro: `kiro`

For Codex, install MCP config plus the global Codex skill:

```bash
gdgraph install "$PROJECT_ROOT" --target codex --with-skill
```

For other clients:

```bash
gdgraph install "$PROJECT_ROOT" --target opencode
```

Replace `opencode` with the actual target when needed.

The generated MCP command is usually:

```bash
gdgraph serve --mcp "$PROJECT_ROOT"
```

Restart the Agent client after install.

## Verify

Run:

```bash
gdgraph status "$PROJECT_ROOT"
gdgraph context "project main_scene autoload input actions" --path "$PROJECT_ROOT"
```

Expected:

- `initialized: true`
- `indexFresh: true`
- context output returns compact graph nodes and paths

After restart, ask the Agent to list or inspect MCP tools. It should expose:

- `godot_status`
- `godot_context`
- `godot_node`
- `godot_sync`

## Usage Guidance For Agents

- Use `godot_context` first for Godot scripts, scenes, resources, signals, autoloads, node paths, call chains, and edit planning.
- Write `godot_context.query` as terse keywords, not a natural-language task.
- Prefer exact class names, method names, constants, fields, resource paths, file/path fragments, and domain nouns.
- For `.tres` resources, include path fragments and exported/resource property names or string values.
- Use `godot_node` to read one indexed file, symbol, or graph node.
- Prefer `godot_node({ file, symbol })` by expanding `context.paths[pN]` and using the node `name` or `qname`.
- For focused source slices, pass `includeNotes: false` to `godot_node` unless relationship notes are needed.
- Compact `paths`, `selectors`, and node ids come only from visible budgeted output; omitted content leaves no aliases behind.
- Treat truncated graph output as navigation, not exhaustive proof.
- For constants, enums, signal names, resource paths, or string protocols, add a focused `rg` or test check when complete reference proof matters.

## Uninstall

Remove Agent config and local graph data:

```bash
gdgraph uninstall "$PROJECT_ROOT" --target codex --with-skill
gdgraph clean "$PROJECT_ROOT"
```

Replace `codex --with-skill` with the target used during install.
