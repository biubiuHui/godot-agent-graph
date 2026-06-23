# Troubleshooting

## No gdgraph index found

Symptom:

```json
{
  "ok": false,
  "initialized": false
}
```

Run:

```bash
gdgraph sync /path/to/godot/project
```

If the path is not a Godot project, make sure it contains `project.godot`.

## Index is stale

Symptom:

```json
{
  "indexFresh": false,
  "stale": true,
  "staleFileCount": 1,
  "staleFiles": ["res://scripts/fixture_actor.gd"],
  "pendingFiles": [
    { "path": "res://scripts/fixture_actor.gd", "indexing": false }
  ]
}
```

Run:

```bash
gdgraph sync /path/to/godot/project
```

From MCP, call:

```text
godot_sync
```

If you are about to edit or rely on a pending file, read that file directly or sync first.

## Sync change counts look like Git status

`gdgraph sync` and `godot_sync` report graph index delta counts:

- `addedCount`
- `modifiedCount`
- `deletedCount`

These fields describe how many Godot files changed in the graph index since the previous index, not Git working tree status. Check `changeScope`; it should be `graph_index`. Path lists are omitted by default and `changeListsOmitted` is `true`.

For `gdgraph sync --rebuild`, the old graph database is removed first. The counts then describe files inserted into the new graph index from scratch.

After the first index, sync is incremental. It parses added and modified Godot files, removes graph records for deleted files, and recomputes resolver-owned relationships. Unchanged indexed files are not rewritten by ordinary sync.

## Force a full graph rebuild

Use the single sync flow with `--rebuild`:

```bash
gdgraph sync /path/to/godot/project --rebuild
```

This removes the existing `.gdgraph` directory and then builds a fresh index. There is no separate `gdgraph rebuild`, `gdgraph build`, `gdgraph init`, or `gdgraph index` command.

Use `gdgraph clean /path/to/godot/project` only when you want to delete `.gdgraph` without rebuilding it.

## Graph database is temporarily locked

Another index or sync operation is currently writing `.gdgraph`. The tool retries briefly before returning a structured locked error.

Wait a moment and run:

```bash
gdgraph sync /path/to/godot/project
```

From MCP, call `godot_sync` again. If the error persists, check for a long-running indexing process.

## Watcher is disabled or degraded

`watcher: "disabled"` means the current command is not running an active watcher, or the tool result came from a one-shot CLI command. This is normal for manual CLI/MCP calls; use `gdgraph sync` manually when freshness says work is pending.

`watcher: "degraded"` means filesystem watching reported an error. Use manual sync while investigating platform file-watch limits or project permissions.

## Parse errors appear in sync output

`parseErrors` are gdgraph parser/extractor errors only. They do not mean Godot compiler or editor import validation passed. Sync output makes this explicit:

```json
{
  "parseErrorScope": "gdgraph_static_parse",
  "compilerChecked": false
}
```

Single-file parse errors do not stop the whole index. Fix the listed Godot file and run:

```bash
gdgraph sync /path/to/godot/project
```

Run Godot or project tests separately when you need compiler/import validation.

## Scene still references a deleted script

The graph can retain a resource reference node for the stale scene reference, but script class and method nodes from the deleted file are removed. Fix the scene reference in Godot or the `.tscn` file, then sync.

## Codex installer skipped configuration

The Codex installer skips an existing unmarked `[mcp_servers.godot-agent-graph]` or `[mcp_servers."godot-agent-graph"]` table because it might be user-owned.

Options:

- edit the existing table manually
- remove the unowned table and run `gdgraph install --target codex`
- use a custom command with `--command`

## Agent installer skipped configuration

The Claude, Cursor, Gemini, and Kiro installers skip an existing `mcpServers["godot-agent-graph"]` entry when it does not exactly match the generated config. The opencode installer does the same for `mcp["godot-agent-graph"]`.

This protects user edits. Remove or rename the custom entry, then run:

```bash
gdgraph install /path/to/project --target <agent>
```

## MCP server does not start

Verify the CLI works first:

```bash
gdgraph version
gdgraph status /path/to/godot/project
gdgraph serve --mcp /path/to/godot/project
```

If the Agent cannot find `gdgraph`, reinstall with an absolute command path:

```bash
gdgraph install /path/to/project --command /absolute/path/to/gdgraph
```
