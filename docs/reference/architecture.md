# Architecture

`godot-agent-graph` builds a local static graph for a Godot project and serves that graph through CLI and MCP tools.

## Storage

The graph database lives at:

```text
<project>/.gdgraph/graph.db
```

It stores:

- `files`: indexed Godot files with content hash, size, modified time, parse errors, and node counts.
- `nodes`: project, scene, scene node, script class, method, property, signal, resource, autoload, and input action nodes.
- `edges`: graph relationships such as `contains`, `attaches_script`, `calls`, `connects_signal`, `loads_resource`, `instantiates_scene`, and `main_scene`.
- `unresolved_refs`: references extracted before resolver completion.
- `project_metadata`: index and sync metadata.
- `nodes_fts`: full-text search index.

## Scanner and Parsers

The scanner finds `project.godot`, `.gd`, `.tscn`, and `.tres` files while ignoring generated directories such as `.gdgraph/`, `.git/`, `.godot/`, `.import/`, `build/`, `dist/`, and `node_modules/`.

Parsers extract:

- project name, main scene, autoloads, and input actions from `project.godot`.
- scene/resources, external resources, subresources, scene nodes, properties, and editor signal connections from `.tscn` and `.tres`.
- class names, methods, properties, signals, calls, emits, loads/preloads, input actions, autoload candidates, and node references from GDScript.

## Index Flow

`indexGodotProject` scans the project, parses files, writes graph records, then runs the resolver. Full indexing is the explicit rebuild path and clears old graph records before writing the new graph.

Missing external resources can still appear as resource reference nodes, but they are detached from `files` so stale scene references do not break indexing.

## Resolver

The resolver turns extracted unresolved references into graph edges when project-local targets can be found. It resolves:

- project main scene
- scene script attachments
- scene instances
- load/preload resources
- autoload resources and usages
- input action usages
- editor signal connections
- project-local `extends`

## Sync and Watcher

`syncGodotProject` compares stored file hashes with the current scan and reports added, modified, and deleted files. It incrementally deletes records owned by deleted or modified files, inserts records extracted from changed files, and recomputes resolver-owned edges from retained reference candidates. Unchanged file records are not rewritten by ordinary sync.

The watcher only discovers file changes, records pending files, and debounces the same sync path. Sync remains the source of truth because watcher events can be coalesced, duplicated, dropped, disabled, or platform-specific.

Graph writes use a `.gdgraph/graph.lock` file to prevent concurrent sync/index writes.

## Query Layer

Graph query APIs power both CLI and MCP:

- project overview and indexed files
- traversal neighborhoods
- Agent-ready context packages with bounded source snippets
- exact indexed source reads by file, symbol, or graph node id

The public query model is intentionally small: `status`, `sync`, `context`, and `node`. Scene, resource, signal, autoload, node-path, call, and symbol-reference data remain indexed graph capabilities, but old standalone query products are not part of the current API surface.

## MCP Server

The MCP server registers Godot-specific tools and provides tool-use instructions. On startup, it performs a catch-up sync and attaches a watcher when the project can be synchronized.

MCP responses include freshness metadata so an Agent can avoid treating stale graph data as final.

## Installer

The installer writes MCP server configuration for supported Agent clients:

- Codex: owned block in `~/.codex/config.toml`
- Claude Code: project `.mcp.json`

Uninstall removes only owned or exact generated gdgraph entries.
