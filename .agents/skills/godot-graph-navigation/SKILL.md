---
name: godot-graph-navigation
description: Use when working in a Godot project and asked to inspect, explain, edit, refactor, review, debug, or trace scripts, scenes, resources, signals, autoloads, node paths, call chains, indexed source, impact, or graph freshness.
---

# Godot Graph Navigation

Use `gdgraph` as the first navigation layer for Godot structure. It is an indexed source map, not an intelligent semantic search engine and not a substitute for final source or test verification.

## Core Workflow

1. Call `godot_status` when index availability, freshness, or project root selection is unclear.
2. If `initialized` is false, `indexEmpty` is true, or `indexFresh` is false, call `godot_sync` once before relying on graph output.
3. Call `godot_context` before broad file search to locate relevant files, symbols, scenes, resources, node paths, relationships, and edit-planning context.
4. Use `godot_node` for indexed source reads by file, symbol, or graph node after `godot_context` identifies a target.
5. Read files, run `rg`, or run tests only for focused verification that the graph output cannot prove.

If MCP tools are unavailable, use the CLI fallback: `gdgraph sync`, `gdgraph context`, and `gdgraph node`, then read only the files the graph points to.

## Query Style

For `godot_context.query`, use terse identifier-heavy keyword queries. Prefer exact class names, method names, constants, fields, signal names, resource paths, file/path fragments, and domain nouns.

For `.tres` resources, include path fragments such as `resources/definitions` and concrete exported/resource property names or literal string values. Resource metadata is searchable, but graph output is still ranked navigation, not exhaustive inventory proof.

Do not write natural-language task instructions such as "find", "include paths", "summarize", "relevant for", or "tell me".

Good:

```text
enemy_spawner spawn_wave WaveConfig export EnemyDefinition spawn_weight scene_path
```

Better when the topic is broad: split into focused queries.

```text
enemy_spawner spawn_wave WaveConfig export
```

```text
EnemyDefinition spawn_weight scene_path
```

Bad:

```text
Find enemy spawning systems, wave config, and enemy resources relevant for writing a design. Include paths and summary.
```

## Verification Boundaries

Treat `godot_context.truncated`, omitted relationships, and `godot_node.notes.omitted` as bounded navigation output, not exhaustive proof.

Use a focused `rg`, direct source read, or test when changing or auditing:

- constants, enums, event kinds, or string protocols
- signal names, node paths, resource paths, and autoload names
- shared interfaces, exported fields, scene wiring, or migration-sensitive code
- broad impact claims such as "all callers", "no references", or "safe to delete"

`parseErrors` are gdgraph static parser/extractor errors only. They do not prove that Godot compiler or editor import validation passed.

## Privacy

Do not copy private project files, source snippets, secrets, generated project data, or local-only paths into public notes, tests, docs, fixtures, examples, commits, or skill files. Summarize private findings generically and keep reusable examples synthetic.
