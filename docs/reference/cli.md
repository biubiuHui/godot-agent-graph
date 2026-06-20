# CLI Reference

Run local development commands with `npm run gdgraph -- <command>`.

Installed package commands use `gdgraph <command>`.

## version

```bash
gdgraph version
```

Prints the package version.

## init

```bash
gdgraph init [path]
```

Creates `.gdgraph/graph.db` and runs a full index for the Godot project at `path` or the current directory.

## index

```bash
gdgraph index [path]
```

Rebuilds the graph from disk. Use this for first-time indexing or recovery.

## rebuild

```bash
gdgraph rebuild [path]
```

Explicit alias for `gdgraph index [path]`. It clears old graph records and rebuilds the index from the current project files.

## clean

```bash
gdgraph clean [path]
```

Removes the project's `.gdgraph` storage directory without rebuilding. After cleaning, `gdgraph status [path]` reports the project as uninitialized until `gdgraph init`, `gdgraph index`, or `gdgraph rebuild` is run again.

## uninit

```bash
gdgraph uninit [path]
```

Alias for `gdgraph clean [path]`. It removes the project's `.gdgraph` storage directory without rebuilding.

## sync

```bash
gdgraph sync [path]
```

Detects added, modified, and deleted Godot files, then refreshes the graph. The result includes `added`, `modified`, `deleted`, and corresponding counts.

## status

```bash
gdgraph status [path]
```

Shows graph database path, file/node/edge counts, project metadata, and freshness metadata.

## files

```bash
gdgraph files [path]
```

Lists indexed Godot files with hashes, sizes, parse errors, and node counts.

## search

```bash
gdgraph search <query> --path <path>
```

Searches graph nodes by symbol, scene, script, signal, resource, autoload, or input action text.

## scene

```bash
gdgraph scene <scene-path> --path <path>
```

Returns indexed scene details and contained scene nodes for a `.tscn` resource path.

## symbol

```bash
gdgraph symbol <name> --path <path>
```

Finds indexed symbols matching the name.

## explore

```bash
gdgraph explore <query> --path <path>
gdgraph explore <query> --path <path> --no-code
```

Returns Agent-ready context for a feature, symbol, scene, or resource query. Includes related nodes, relationship explanations, and bounded source snippets unless `--no-code` is used.

## callers

```bash
gdgraph callers <symbol> --path <path>
```

Returns incoming call context and related graph relationships for a symbol.

## callees

```bash
gdgraph callees <symbol> --path <path>
```

Returns outgoing call context and related graph relationships for a symbol.

## impact

```bash
gdgraph impact <symbol-or-file> --path <path>
```

Returns likely affected scenes, scripts, resources, relationship paths, and recommended files to check before editing.

## serve

```bash
gdgraph serve --mcp [path]
```

Starts the MCP stdio server. Startup performs a catch-up sync and, when possible, attaches a watcher that tracks pending files.

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
```

Writes gdgraph MCP configuration for supported Agent clients. Supported targets are `all`, `codex`, `claude`, `cursor`, `opencode`, `gemini`, and `kiro`.

## uninstall

```bash
gdgraph uninstall [path]
gdgraph uninstall [path] --target codex
gdgraph uninstall [path] --target claude
gdgraph uninstall [path] --target cursor
gdgraph uninstall [path] --target opencode
gdgraph uninstall [path] --target gemini
gdgraph uninstall [path] --target kiro
```

Removes only gdgraph-owned or exact generated MCP configuration.
