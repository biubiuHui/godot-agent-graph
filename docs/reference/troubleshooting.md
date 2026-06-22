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
gdgraph init /path/to/godot/project
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

## Sync change arrays look like Git status

`gdgraph sync` and `godot_sync` report graph index deltas:

- `added`
- `modified`
- `deleted`

These fields describe which Godot files changed in the graph index since the previous index, not Git working tree status. Check `changeScope`; it should be `graph_index`.

## Graph database is temporarily locked

Another index or sync operation is currently writing `.gdgraph`. The tool retries briefly before returning a structured locked error.

Wait a moment and run:

```bash
gdgraph sync /path/to/godot/project
```

From MCP, call `godot_sync` again. If the error persists, check for a long-running indexing process.

## Watcher is disabled or degraded

`watcher: "disabled"` means the current command is not running an active watcher, or the tool result came from a one-shot CLI command. Use `gdgraph sync` manually.

`watcher: "degraded"` means filesystem watching reported an error. Use manual sync while investigating platform file-watch limits or project permissions.

## Parse errors appear in file records

Single-file parse errors are recorded on the file and do not stop the whole index. Inspect file output:

```bash
gdgraph files /path/to/godot/project
```

Then fix the listed Godot file and run:

```bash
gdgraph sync /path/to/godot/project
```

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
