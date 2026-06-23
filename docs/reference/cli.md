# CLI Reference

Run local development commands with `npm run gdgraph -- <command>`.

Installed package commands use `gdgraph <command>`.

## version

```bash
gdgraph version
```

Prints the package version.

## sync

```bash
gdgraph sync [path]
gdgraph sync [path] --rebuild
```

Creates or updates `.gdgraph/graph.db` for the Godot project at `path` or the current directory.

Sync is incremental after the first index: it parses added and modified Godot files, removes graph records for deleted files, and recomputes resolver-owned relationships from stored reference candidates. Unchanged indexed files are not rewritten by ordinary sync.

Use `--rebuild` to remove the existing `.gdgraph` directory before syncing. This performs a fresh full index through the same sync pipeline and returns `rebuilt: true` when the rebuild succeeds. In rebuild output, change counts describe files inserted into the new graph index, not Git status.

The result includes `addedCount`, `modifiedCount`, `deletedCount`, `changeListsOmitted: true`, and `changeScope: "graph_index"`. Full path lists are omitted to keep CLI and agent output compact.

`parseErrors` are gdgraph parser/extractor errors only. Sync output includes:

```json
{
  "parseErrorScope": "gdgraph_static_parse",
  "compilerChecked": false
}
```

Godot compiler/editor import validation still requires running Godot or project tests separately.

## status

```bash
gdgraph status [path]
```

Shows initialization state, graph database path, file/node/edge counts, project metadata, and freshness metadata.

If `initialized:false` or `indexEmpty:true`, run `gdgraph sync [path]` before graph queries.

## context

```bash
gdgraph context <query> --path <path>
gdgraph context <query> --path <path> --code
gdgraph context <query> --path <path> --max-files 10
```

Returns a compact graph navigation package for scripts, scenes, resources, signals, autoloads, node paths, call chains, flow, and edit planning.

This is the CLI equivalent of `godot_context`. It is a bounded navigation result, not an exhaustive proof chain.

Write `<query>` as a short keyword and identifier string. Prefer exact class names, method names, constants, fields, resource paths, file/path fragments, and domain nouns.

Good:

```bash
gdgraph context "enemy_spawner spawn_wave WaveConfig export EnemyDefinition spawn_weight scene_path" --path <path>
```

Avoid natural-language task wording such as `find`, `include paths`, `summarize`, `relevant for`, or `tell me`.

## node

```bash
gdgraph node --path <path> --file res://scripts/fixture_actor.gd
gdgraph node --path <path> --symbol FixtureActor
gdgraph node --path <path> --symbol shared_name --file res://scripts/example.gd
gdgraph node --path <path> --id script:res://scripts/fixture_actor.gd
gdgraph node --path <path> --file res://scripts/fixture_actor.gd --offset 1 --limit 80
gdgraph node --path <path> --symbol FixtureActor --no-code
gdgraph node --path <path> --id script:res://scripts/fixture_actor.gd --symbols-only
```

Reads exact indexed source or metadata for one file, symbol, or graph node id.

Selector rules:

- `--id` is exclusive.
- `--symbol` may be combined with `--file` to disambiguate same-name symbols.
- `--file` alone reads the indexed file.

## clean

```bash
gdgraph clean [path]
```

Removes the project's `.gdgraph` storage directory without rebuilding. After cleaning, `gdgraph status [path]` reports the project as uninitialized until `gdgraph sync [path]` is run.

`clean` only removes local graph data. It does not remove MCP or Agent configuration; use `gdgraph uninstall` for that.

## serve

```bash
gdgraph serve --mcp [path]
```

Starts the MCP stdio server. Startup performs a catch-up sync and, when possible, attaches a watcher that tracks pending files and debounces the same incremental sync path.

## install

```bash
gdgraph install [path]
gdgraph install [path] --target codex
gdgraph install [path] --target claude
gdgraph install [path] --target cursor
gdgraph install [path] --target opencode
gdgraph install [path] --target gemini
gdgraph install [path] --target kiro
gdgraph install [path] --command /absolute/path/to/gdgraph
gdgraph install [path] --target codex --with-skill
```

Writes gdgraph MCP configuration for supported Agent clients. Supported targets are `all`, `codex`, `claude`, `cursor`, `opencode`, `gemini`, and `kiro`.

`--with-skill` is only used by the Codex target. It additionally installs the optional global Codex skill directory at `~/.codex/skills/godot-graph-navigation/`, or under the `--home` directory when `--home` is provided.

## uninstall

```bash
gdgraph uninstall [path]
gdgraph uninstall [path] --target codex
gdgraph uninstall [path] --target claude
gdgraph uninstall [path] --target cursor
gdgraph uninstall [path] --target opencode
gdgraph uninstall [path] --target gemini
gdgraph uninstall [path] --target kiro
gdgraph uninstall [path] --target codex --with-skill
```

Removes only gdgraph-owned or exact generated MCP configuration.

With the Codex target, `--with-skill` also removes the generated global Codex skill when it still exactly matches the bundled skill. User-modified skill files are preserved.

To stop using gdgraph for a project completely:

```bash
gdgraph uninstall /path/to/project --target codex --with-skill
gdgraph clean /path/to/project
npm uninstall -g godot-agent-graph
```
