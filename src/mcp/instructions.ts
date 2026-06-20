export function getMcpInstructions(): string {
  return [
    "Use godot-agent-graph as the first map for Godot project structure.",
    "For architecture questions, call godot_project_map before reading many files.",
    "For focused lookup, use godot_search and godot_scene.",
    "Do not start with broad grep/read to rebuild scene, script, signal, resource, autoload, or input structure.",
    "Every major tool returns indexFresh, pendingFiles, watcher, and lastSyncAt. Treat indexFresh=false conservatively and run godot_sync or gdgraph sync before trusting stale answers.",
  ].join("\n");
}
