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

`godot_context` does not auto-bootstrap arbitrary `projectPath` values. For a new worktree, copied project, missing `.gdgraph/graph.db`, or empty index, call `godot_sync` manually once, then retry `godot_context`. Missing-index responses include `nextTools: [{ "tool": "godot_sync", ... }]` to make this recovery path explicit.

## Freshness Contract

Most graph query responses include:

```json
{
  "indexFresh": true,
  "pendingFileCount": 0,
  "watcher": "disabled",
  "lastSyncAt": 1780000000000,
  "lastSyncAtSource": "sync"
}
```

When `indexFresh` is false, the graph may not include pending file changes. Call `godot_sync` or inspect the listed files before treating results as final.

Use `indexFresh` and `pendingFileCount` as the graph-query freshness signal. `lastSyncAtSource` is diagnostic metadata: `"sync"` means explicit sync metadata, `"index"` means the timestamp fell back to index metadata, and `"unknown"` means an older or manually altered index has no usable timestamp.

Stale graph query responses also include `stale: true`, `staleFileCount`, compact `staleFiles` path refs when the pending file is present in the response `paths` table, and `staleFilesOmitted` for pending files outside that table.

`godot_status` is the full freshness inspection tool. It returns flat freshness fields plus the structured `pendingFiles` list, without a nested `freshness` object.

## godot_status

Input:

```json
{ "projectPath": "/path/to/project" }
```

Returns a concise health check: initialization state, live graph counts, `indexEmpty`, and flat freshness fields.

When `initialized:false` or `indexEmpty:true`, the response is a recoverable setup state. Run `godot_sync` manually once for that project path before relying on graph queries.

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

If the project has no usable index, `godot_context` returns the same missing-index recovery payload as `godot_status` instead of silently indexing. Agents should call `godot_sync` manually, then retry the original context query.

`query` is a keyword and identifier search string, not a natural-language task instruction. Prefer short queries made of exact class names, method names, constants, fields, resource paths, file/path fragments, and domain nouns.

Good:

```text
enemy_spawner spawn_wave WaveConfig export EnemyDefinition spawn_weight scene_path
```

For broad work, split into focused queries:

```text
enemy_spawner spawn_wave WaveConfig export
EnemyDefinition spawn_weight scene_path
spawn_weight constants probability odds candidate_generation
```

Avoid task-style wording such as `find`, `include paths`, `summarize`, `relevant for`, or `tell me`; those words add noise without improving graph ranking.

For `.tres` resources, include directory fragments such as `resources/definitions` and metadata terms such as exported property names or literal string/number/boolean values. Resource metadata participates in search and ranking, but `godot_context` remains a bounded navigation package, not an exhaustive resource inventory.

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
      "kind": "script_class",
      "name": "TargetPanel",
      "path": "p1",
      "line": 2
    },
    {
      "id": "n2",
      "kind": "method",
      "name": "refresh",
      "path": "p1",
      "line": 8
    }
  ],
  "relationships": [
    { "from": "n1", "kind": "contains", "to": "n2", "provenance": "parser" }
  ],
  "selectors": {
    "n3": { "kind": "scene_node", "path": "p2", "suffix": "Main/TargetPanel" }
  },
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

Use `paths` to expand compact path ids. `entryPoints` are the ranked starting nodes for the query. Exact symbols, file paths, CamelCase terms, and snake_case terms are ranked entry candidates. `pathsBetween` highlights direct graph edges between entry points when found. `blastRadius` appears only for edit/impact-style queries and gives a compact first check-file set, not a full transitive impact report. For source follow-up, expand `paths[pN]` and call `godot_node({ file, symbol })` with the node `name` or `qname`. `selectors` appears for graph-id-only targets such as scene nodes and for relationship endpoints outside the visible `nodes[]` list. `truncated` and `omitted` tell the agent when the response stayed within budget by dropping lower-priority entries.

`truncated:true` means the response is a navigation package, not a complete proof chain. For high-risk edits that depend on complete reference coverage, follow up with `godot_node`, a narrow `rg`, or tests.

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

Selector rules:

- `id` is exclusive.
- `symbol` may be combined with `file` to disambiguate same-name symbols.
- `file` alone reads the indexed file.

Responses include concise relationship notes:

```json
{
  "paths": { "p1": "res://scripts/fixture_actor.gd" },
  "target": { "id": "n1", "kind": "script_class", "name": "FixtureActor", "path": "p1" },
  "source": { "path": "p1", "start": 2, "end": 24, "text": "..." },
  "notes": {
    "callers": [{ "id": "n2", "kind": "method", "name": "_ready", "path": "p1" }],
    "callees": [],
    "dependents": [],
    "dependencies": [],
    "limit": 8,
    "omitted": {
      "callers": 0,
      "callees": 0,
      "dependents": 0,
      "dependencies": 0
    }
  }
}
```

Relationship notes are bounded summaries. Cross-file `references_symbol` evidence is prioritized ahead of local structural edges, but nonzero `notes.omitted` still means additional relationships exist outside the response. For constants, enums, signal names, resource paths, and string protocols, use a narrow `rg` or tests when exhaustive impact proof matters.

If a relationship note points to a node already expanded in `target` or `symbols[]`, the note may be just `{ "id": "nN" }`. Resolve that id against the expanded target or symbol entry.

If the selected indexed file is pending watcher/sync processing, the response includes `stale: true` and compact `staleFiles` path refs alongside the normal freshness fields. This is the graph-native substitute for raw `Read` on indexed Godot files.

## godot_sync

Input:

```json
{ "projectPath": "/path/to/project" }
```

Detects added, modified, and deleted Godot files, incrementally updates the graph, clears pending files, and returns change counts plus freshness. `addedCount`, `modifiedCount`, and `deletedCount` describe graph index changes, not Git status; responses include `changeScope: "graph_index"` to make that explicit. If the graph is temporarily locked by another sync/index operation, retry `godot_sync` after the lock clears.

After the first index, `godot_sync` parses added and modified files, removes graph records for deleted files, and recomputes resolver-owned relationships from retained reference candidates. Unchanged indexed files are not rewritten by ordinary sync. A watcher, when active, only schedules this same sync path.

`parseErrors` are gdgraph parser/extractor errors only. `godot_sync` returns `parseErrorCount`, includes at most the first 10 parse error strings, and adds `parseErrorsOmitted` when more errors exist. It does not run the Godot editor, compiler, or importer:

```json
{
  "parseErrorCount": 0,
  "parseErrorScope": "gdgraph_static_parse",
  "compilerChecked": false
}
```

Path lists and local database paths are omitted by default to keep agent output compact:

```json
{
  "addedCount": 30,
  "modifiedCount": 0,
  "deletedCount": 0,
  "changeListsOmitted": true
}
```
