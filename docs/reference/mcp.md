# MCP Tools Reference

Start the server:

```bash
gdgraph serve --mcp /path/to/godot/project
```

Each tool accepts an optional `projectPath`. When omitted, the server project root is used.

MCP responses are compact JSON because they are meant to be read by agents. Pretty-printed CLI/debug views should use CLI commands or lower-level APIs instead. See [Agent Output Reference](./agent-output.md) for the formatter contract, budgets, and privacy rules behind these payloads.

## Agent-Native Default Surface

The MCP server's default visible tools are:

- `godot_status`
- `godot_context`
- `godot_node`
- `godot_sync`

Use `godot_context` first for ordinary Godot understanding, flow, structure, and edit-planning tasks. Use `godot_node` whenever you would otherwise read an indexed Godot file or named symbol. Do not rebuild indexed Godot structure with broad grep/read loops. Raw file reads are only for unindexed files, files listed as stale, or external validation such as compiler/test output.

Legacy focused handlers such as `godot_search`, `godot_scene`, `godot_explore`, `godot_symbol`, `godot_callers`, `godot_callees`, `godot_impact`, and `godot_project_map` remain callable for compatibility and debugging, but they are no longer the default agent tool surface.

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

Stale graph query responses also include `stale: true`, `staleFileCount`, and `staleFiles` as a concise action list. `pendingFiles` remains the structured compatibility field.

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

Primary first call for ordinary Godot code, scene, resource, signal, node-path, call-chain, flow, and edit-planning questions. Returns concise status fields, live graph counts, bounded context, and graph-native next steps when more context is needed.

`context` uses the compact agent format:

```json
{
  "query": "FixtureActor",
  "prefixes": { "@p1": "res://scripts/ui/panels/" },
  "paths": { "p1": "@p1/target_panel.gd" },
  "entryPoints": ["n1"],
  "nodes": [
    {
      "id": "n1",
      "graphId": "script:res://scripts/ui/panels/target_panel.gd",
      "kind": "script_class",
      "name": "TargetPanel",
      "path": "p1",
      "line": 2
    },
    {
      "id": "n2",
      "graphId": "method:res://scripts/ui/panels/target_panel.gd:refresh",
      "kind": "method",
      "name": "refresh",
      "path": "p1",
      "line": 8
    }
  ],
  "relationships": [
    { "from": "n1", "kind": "contains", "to": "n2", "provenance": "parser" }
  ],
  "pathsBetween": [
    { "from": "n1", "kind": "calls", "to": "n2", "provenance": "resolver" }
  ],
  "blastRadius": {
    "entryPoints": ["n1"],
    "checkFiles": ["p1"],
    "relationshipCount": 3
  },
  "snippets": [
    { "path": "p1", "start": 1, "end": 20, "text": "..." }
  ],
  "truncated": false,
  "omitted": { "nodes": 0, "relationships": 0, "snippets": 0 },
  "budget": { "maxChars": 4800, "estimatedChars": 2100 }
}
```

Use `paths` to expand compact path ids. `entryPoints` are the ranked starting nodes for the query. Long natural-language queries preserve exact symbols, file paths, CamelCase terms, and snake_case terms as ranked entry candidates. `pathsBetween` highlights direct graph edges between entry points when found. `blastRadius` appears only for edit/impact-style queries and gives a compact first check-file set, not a full transitive impact report. Use `graphId` with `godot_node` when a specific indexed node needs source. `truncated` and `omitted` tell the agent when the response stayed within budget by dropping lower-priority entries.

Ordinary constant/property reads can appear as `references_symbol` relationships. This means "the source node names or reads the target symbol"; it is not a call edge. Ambiguous same-name symbols stay unresolved instead of being guessed.

## godot_node

Input:

```json
{
  "projectPath": "/path/to/project",
  "file": "res://scripts/fixture_actor.gd",
  "offset": 1,
  "limit": 80
}
```

Alternative inputs:

```json
{ "projectPath": "/path/to/project", "symbol": "FixtureActor" }
```

```json
{ "projectPath": "/path/to/project", "id": "script:res://scripts/fixture_actor.gd" }
```

Returns indexed source for a Godot file, graph node id, or symbol. File reads support `offset` and `limit`, and source text is returned with line numbers. Symbol and graph-node reads prefer indexed `startLine` / `endLine` ranges so methods, scene nodes, and resources return the relevant body/window instead of a file-head dump. `symbolsOnly: true` returns indexed symbols for a file without source text. `includeCode: false` omits the `source` block but still returns target metadata and relationship notes.

Responses include concise relationship notes:

```json
{
  "notes": {
    "callers": [{ "id": "method:...", "kind": "method", "name": "_ready" }],
    "callees": [],
    "dependents": [],
    "dependencies": []
  }
}
```

If the selected indexed file is pending watcher/sync processing, the response includes `stale: true` and `staleFiles` alongside the normal freshness fields. This is the graph-native substitute for raw `Read` on indexed Godot files.

## godot_sync

Input:

```json
{ "projectPath": "/path/to/project" }
```

Detects added, modified, and deleted Godot files, refreshes the graph, clears pending files, and returns change counts plus freshness. `added`, `modified`, and `deleted` describe graph index changes, not Git status; responses include `changeScope: "graph_index"` to make that explicit. If the graph is temporarily locked by another sync/index operation, retry `godot_sync` after the lock clears.

For small changes, `added`, `modified`, and `deleted` contain the exact path lists. For large changes, each list is capped and paired with omitted counts:

```json
{
  "added": ["res://scripts/example_0.gd"],
  "addedCount": 30,
  "addedOmitted": 10,
  "changeListLimit": 20
}
```

## Legacy Compatibility Tools

The following handlers remain available for existing clients, tests, CLI parity, and debugging. Agents should prefer the default surface above unless they have a specific compatibility reason.

Legacy MCP handlers also use compact agent-facing payloads. They may differ from CLI debug output: paths are interned through `paths`, graph nodes use compact ids plus `graphId`, relationships are structured objects, and lower-priority entries are represented by `truncated` / `omitted` metadata.

## godot_project_map

Input:

```json
{ "projectPath": "/path/to/project" }
```

Returns a large top-level project overview for architecture/design orientation: graph counts, project metadata, file/node/edge counts by kind, main scenes, script class summaries, resource directory summaries, parse errors, and freshness. Use cautiously, only when a top-level design view is needed. It intentionally omits full indexed file metadata; use `gdgraph files` from the CLI when the full file table is needed.

## godot_search

Input:

```json
{
  "projectPath": "/path/to/project",
  "query": "FixtureActor",
  "limit": 20
}
```

Returns matching graph nodes in a compact shape:

```json
{
  "paths": { "p1": "res://scripts/fixture_actor.gd" },
  "results": [
    { "id": "n1", "graphId": "script:res://scripts/fixture_actor.gd", "kind": "script_class", "path": "p1" }
  ],
  "omitted": { "nodes": 0, "relationships": 0, "snippets": 0 }
}
```

## godot_scene

Input:

```json
{
  "projectPath": "/path/to/project",
  "scenePath": "res://fixture_main.tscn"
}
```

Returns a compact scene tree summary. Scene nodes include compact ids, `graphId`, name, scene-local path, Godot type, parent path, attached script path reference, instanced scene path reference, and source line. Full raw node metadata remains available through lower-level graph APIs and CLI output, but MCP omits it to avoid flooding agent context with editor/layout properties.

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

Returns the same compact `context` payload shape as `godot_context`.

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

Returns symbol details, nearby relationships, and optional snippets in the compact `context` payload shape.

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

Returns incoming call and symbol-reference context in the compact `context` payload shape. Relationship explanations may include `calls`, signal edges, and `references_symbol` for ordinary constant/property reads.

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

Returns outgoing call context and relationship explanations in the compact `context` payload shape.

## godot_impact

Input:

```json
{
  "projectPath": "/path/to/project",
  "target": "res://scripts/fixture_actor.gd"
}
```

Returns focused direct blast-radius context: compact target, directly affected scripts/scenes/resources, prioritized structured relationships, recommended check-file path refs, and `omitted` counts for broad transitive branches that were summarized instead of returned. This is intended for edit planning and test selection, not as a full dependency graph dump.
