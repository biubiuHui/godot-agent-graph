export function getMcpInstructions(): string {
  return [
    "Use godot_context as the primary first call for Godot project structure, scripts, scenes, resources, signals, node paths, call-chain questions, and edit planning.",
    "Use godot_node as the graph-native source read for indexed Godot files or named symbols; treat its returned source as already read.",
    "Use godot_status to check index health and freshness before trusting a stale answer.",
    "Use godot_sync only when indexFresh=false, watcher sync is unavailable, or you need an explicit catch-up before graph answers.",
    "For godot_context.query, use terse identifier-heavy keyword queries made of exact class names, method names, constants, fields, resource paths, file/path fragments, and domain nouns.",
    "Do not write natural-language task instructions in godot_context.query, such as find, include paths, summarize, relevant for, or tell me.",
    "Do not rebuild indexed Godot structure with broad grep/read; the graph already indexed scene, script, signal, resource, autoload, and input relationships.",
    "Use raw Read only for unindexed files or files listed as stale in pendingFiles/freshness metadata.",
    "Treat godot_context truncated=true and godot_node notes.omitted counts as bounded navigation output, not exhaustive proof of every relationship.",
    "For edits involving constants, enums, signal names, resource paths, or string protocols, add a narrow rg/test check to confirm references after graph navigation.",
    "Every major tool returns indexFresh, pendingFiles, watcher, lastSyncAt, and lastSyncAtSource. Treat indexFresh=false conservatively and inspect only the listed stale files or run godot_sync.",
  ].join("\n");
}
