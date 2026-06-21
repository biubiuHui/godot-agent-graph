# MCP Tools Reference

Start the server:

```bash
gdgraph serve --mcp /path/to/godot/project
```

Each tool accepts an optional `projectPath`. When omitted, the server project root is used.

## Freshness Contract

Most graph query responses include:

```json
{
  "indexFresh": true,
  "pendingFiles": [],
  "watcher": "disabled",
  "lastSyncAt": 1780000000000,
  "freshness": {
    "indexFresh": true,
    "pendingFiles": [],
    "watcher": "disabled",
    "lastSyncAt": 1780000000000
  }
}
```

When `indexFresh` is false, the graph may not include pending file changes. Call `godot_sync` or inspect the listed files before treating results as final.

`godot_status` is intentionally shorter and returns only flat freshness fields, without the nested `freshness` object.

## godot_status

Input:

```json
{ "projectPath": "/path/to/project" }
```

Returns a concise health check: initialization state, live graph counts, `indexEmpty`, and flat freshness fields.

## godot_context

Input:

```json
{
  "projectPath": "/path/to/project",
  "query": "FixtureActor",
  "maxFiles": 6,
  "includeCode": false
}
```

Primary first call for ordinary Godot code, scene, resource, signal, node-path, and call-chain questions. Returns concise status fields, live graph counts, bounded context, and recommended follow-up tools. Use focused tools such as `godot_search`, `godot_scene`, and `godot_impact` after this first pass.

## godot_project_map

Input:

```json
{ "projectPath": "/path/to/project" }
```

Returns a large top-level project overview for architecture/design orientation: graph counts, project metadata, file/node/edge counts by kind, main scenes, script class summaries, resource directory summaries, parse errors, and freshness. Use cautiously, only when a top-level design view is needed. It intentionally omits full indexed file metadata; use `gdgraph files` from the CLI when the full file table is needed.

## godot_sync

Input:

```json
{ "projectPath": "/path/to/project" }
```

Detects added, modified, and deleted Godot files, refreshes the graph, clears pending files, and returns change counts plus freshness.

## godot_search

Input:

```json
{
  "projectPath": "/path/to/project",
  "query": "FixtureActor",
  "limit": 20
}
```

Returns matching graph nodes.

## godot_scene

Input:

```json
{
  "projectPath": "/path/to/project",
  "scenePath": "res://fixture_main.tscn"
}
```

Returns a compact scene tree summary. Scene nodes include the node id, name, scene-local path, Godot type, parent path, attached script path, instanced scene path, and source line. Full raw node metadata remains available through lower-level graph APIs and CLI output, but MCP omits it to avoid flooding agent context with editor/layout properties.

## godot_explore

Input:

```json
{
  "projectPath": "/path/to/project",
  "query": "FixtureActor",
  "maxFiles": 6,
  "includeCode": true
}
```

Returns Agent-ready context: relevant nodes, relationships, explanations, files, and bounded source snippets.

## godot_symbol

Input:

```json
{
  "projectPath": "/path/to/project",
  "symbol": "FixtureActor",
  "maxFiles": 6,
  "includeCode": true
}
```

Returns symbol details, nearby relationships, and optional snippets.

## godot_callers

Input:

```json
{
  "projectPath": "/path/to/project",
  "symbol": "damage",
  "maxFiles": 6,
  "includeCode": true
}
```

Returns incoming call context and relationship explanations.

## godot_callees

Input:

```json
{
  "projectPath": "/path/to/project",
  "symbol": "FixtureActor",
  "maxFiles": 6,
  "includeCode": true
}
```

Returns outgoing call context and relationship explanations.

## godot_impact

Input:

```json
{
  "projectPath": "/path/to/project",
  "target": "res://scripts/fixture_actor.gd"
}
```

Returns directly affected scripts, scenes, resources, relationship paths, and recommended check files.
