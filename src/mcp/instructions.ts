export function getMcpInstructions(): string {
  return [
    "Use godot_context as the first call for Godot project structure, scripts, scenes, resources, signals, node paths, or call-chain questions.",
    "For focused follow-up, use godot_search and godot_scene.",
    "Do not start with broad grep/read to rebuild scene, script, signal, resource, autoload, or input structure.",
    "Every major tool returns indexFresh, pendingFiles, watcher, and lastSyncAt. Treat indexFresh=false conservatively and run godot_sync or gdgraph sync before trusting stale answers.",
    "For godot_search, results=[] means no matches for that query; use indexEmpty, fileCount, and nodeCount to decide whether the index itself is empty.",
  ].join("\n");
}
