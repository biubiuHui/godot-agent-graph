# Architecture

`godot-agent-graph` builds a local static graph for a Godot project and serves that graph through CLI and MCP tools.

## Storage

The graph database lives at:

```text
<project>/.gdgraph/graph.db
```

It stores:

- `files`: indexed Godot files with content hash, size, modified time, parse errors, and node counts.
- `nodes`: project, scene, scene node, script class, method, property, signal, resource, autoload, and input action nodes, including JSON metadata for resource properties and parser details.
- `edges`: graph relationships such as `contains`, `attaches_script`, `calls`, `connects_signal`, `loads_resource`, `instantiates_scene`, and `main_scene`.
- `unresolved_refs`: references extracted before resolver completion.
- `project_metadata`: index and sync metadata.
- `nodes_fts`: full-text search index for names and qualified names. Query ranking also uses node file paths and metadata text.

## Scanner and Parsers

The scanner finds `project.godot`, `.gd`, `.tscn`, and `.tres` files while ignoring generated directories such as `.gdgraph/`, `.git/`, `.godot/`, `.import/`, `build/`, `dist/`, and `node_modules/`.

Parsers extract:

- project name, main scene, autoloads, and input actions from `project.godot`.
- scene/resources, external resources, subresources, scene nodes, properties, and editor signal connections from `.tscn` and `.tres`.
- class names, methods, properties, signals, calls, emits, loads/preloads, input actions, autoload candidates, and node references from GDScript.

## Index Flow

`indexGodotProject` scans the project, parses files, writes graph records, then runs the resolver. Full indexing is the explicit rebuild path and clears old graph records before writing the new graph.

Missing external resources can still appear as resource reference nodes, but they are detached from `files` so stale scene references do not break indexing.

This project is still in a breaking development phase. After graph/index contract changes, discard old local graph storage before trusting query output:

```bash
gdgraph clean /path/to/godot/project
gdgraph sync /path/to/godot/project
```

The implementation intentionally does not keep old-index repair code.

## Node Address Semantics

Graph node ids are storage keys, not agent-facing path contracts. Query and output code use centralized node-address helpers to decide whether a node has an indexed owner file, a readable source path, a display path, a reference path, or only an opaque selector.

Agent output assigns response-local compact ids such as `n1` after selection and budgeting. Follow-up reads should expand `context.paths[pN]` and use `godot_node` with `file` plus `symbol` when possible. Raw graph ids appear only when an explicit selector is required.

## Resource Roles

Resource records keep an explicit role in node address metadata:

| Role | Meaning |
| --- | --- |
| `resource_main` | Indexed `.tres`, `.res`, or scene/resource file. |
| `resource_subresource` | Subresource owned by an indexed scene or resource file. |
| `resource_external_ref` | Reference to another project file that may resolve to an indexed node. |
| `resource_missing_ref` | Reference path that is missing or not indexed. |

This lets resource queries rank authored resources and metadata without treating missing references as readable source files.

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

Graph writes use a small same-process write coordinator plus a `.gdgraph/graph.lock` file. The coordinator keeps startup sync, watcher sync, and manual `godot_sync` calls from colliding inside one process; the lock remains the cross-process guard. Lock responses are compact retry payloads.

## Query Layer

Graph query APIs power both CLI and MCP:

- project overview and indexed files
- traversal neighborhoods
- Agent-ready context packages with bounded source snippets
- exact indexed source reads by file, symbol, or graph node id
- resource-aware search over `.tres` path fragments, property names, and primitive metadata values

The public query model is intentionally small: `status`, `sync`, `context`, and `node`. Scene, resource, signal, autoload, node-path, call, and symbol-reference data remain indexed graph capabilities, but old standalone query products are not part of the current API surface.

`godot_context` chooses one fixed internal strategy for a query:

| Strategy | Use |
| --- | --- |
| `resource-first` | Resource paths, `.tres`/`.tscn` terms, exported property names, and metadata values. |
| `symbol-first` | Classes, methods, constants, properties, and signal names. |
| `relationship` | Dependents, dependencies, callers, callees, references, and impact-style questions. |
| `source-oriented` | Exact file/source-window follow-ups. |
| `general` | Mixed navigation when no narrower strategy fits. |

The strategy is returned as metadata so an agent can interpret ranking. It is not a personalization or extension system.

Relationship output is bounded. `godot_context.completeness` and `godot_node.notes.complete` tell the agent whether a result is complete; omitted counts alone are not proof of exhaustiveness.

`godot_node` is the focused source read path. Use `includeNotes: false` when the agent needs source text without relationship summaries.

## MCP Server

The MCP server registers Godot-specific tools and provides tool-use instructions. On startup, it performs a catch-up sync and attaches a watcher when the project can be synchronized.

MCP responses include freshness metadata so an Agent can avoid treating stale graph data as final.

## Installer

The installer writes MCP server configuration for supported Agent clients:

- Codex: owned block in `~/.codex/config.toml`
- Claude Code: project `.mcp.json`
- Cursor: project `.cursor/mcp.json`
- opencode: project `opencode.jsonc` or existing `opencode.json`
- Gemini: project `.gemini/settings.json`
- Kiro: project `.kiro/settings/mcp.json`

Uninstall removes only owned or exact generated gdgraph entries.
