---
name: godot-graph-navigation
description: Use when asked to inspect, explain, edit, refactor, review, debug, or trace Godot scripts, scenes, resources, signals, autoloads, node paths, call chains, impact, or project structure.
---

# Godot Graph Navigation

Use the graph before broad file search.

1. Call `godot_context` first for most Godot questions.
2. Call `godot_status` when freshness or index availability is unclear.
3. If `indexFresh` is false, call `godot_sync` before relying on graph results.
4. Use `godot_search`, `godot_scene`, `godot_symbol`, `godot_callers`, and `godot_callees` for focused follow-up.
5. Before edits, refactors, reviews, or debugging changes, call `godot_impact`.
6. Use `godot_project_map` only for broad architecture orientation.
7. If MCP tools are unavailable, use the `gdgraph` CLI first, then read only the files the graph points to.

Do not copy private project files, source snippets, secrets, or local-only paths into public notes, tests, or docs.
