export function getMcpInstructions(): string {
  return [
    "Use godot_context as the primary first call for Godot project structure, scripts, scenes, resources, signals, node paths, call-chain questions, and edit planning.",
    "Use godot_node as the graph-native source read for indexed Godot files or named symbols; treat its returned source as already read.",
    "Use godot_status to check index health and freshness before trusting a stale answer.",
    "Use godot_sync only when indexFresh=false, watcher sync is unavailable, or you need an explicit catch-up before graph answers.",
    "Do not rebuild indexed Godot structure with broad grep/read; the graph already indexed scene, script, signal, resource, autoload, and input relationships.",
    "Use raw Read only for unindexed files or files listed as stale in pendingFiles/freshness metadata.",
    "Every major tool returns indexFresh, pendingFiles, watcher, and lastSyncAt. Treat indexFresh=false conservatively and inspect only the listed stale files or run godot_sync.",
  ].join("\n");
}
