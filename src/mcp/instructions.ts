export function getMcpInstructions(): string {
  return [
    "Use godot_context as the primary first call for Godot project structure, scripts, scenes, resources, signals, node paths, call-chain questions, and edit planning.",
    "Use godot_node as the graph-native source read for indexed Godot files or named symbols; treat its returned source as already read.",
    "Context and node payloads use compact local ids: expand context.paths[pN] and prefer godot_node with file plus symbol for follow-up reads.",
    "For focused source slices, pass includeNotes=false to godot_node unless relationship notes are needed.",
    "Use godot_status to check index health and freshness before trusting a stale answer.",
    "Use godot_sync only when indexFresh=false, watcher sync is unavailable, or you need an explicit catch-up before graph answers.",
    "After a breaking index/schema upgrade or invalid local graph, run gdgraph clean <project> then gdgraph sync <project> before querying.",
    "For godot_context.query, use terse identifier-heavy keyword queries made of exact class names, method names, constants, fields, resource paths, file/path fragments, and domain nouns.",
    "For .tres resource queries, include path fragments and exported/resource property names or literal string values; treat results as navigation, not exhaustive inventory.",
    "Do not write natural-language task instructions in godot_context.query, such as find, include paths, summarize, relevant for, or tell me.",
    "Do not rebuild indexed Godot structure with broad grep/read; the graph already indexed scene, script, signal, resource, autoload, and input relationships.",
    "Use raw Read only for unindexed files or files listed as stale by graph freshness metadata.",
    "Use godot_context strategy and completeness fields as scope signals; they are fixed query strategies, not user profiles.",
    "Treat godot_context truncated=true and completeness.complete=false as bounded navigation output, not exhaustive proof of every relationship.",
    "Treat godot_node notes as exhaustive only when notes.complete=true; otherwise inspect notes.omitted and follow up narrowly.",
    "For edits involving constants, enums, signal names, resource paths, or string protocols, add a narrow rg/test check to confirm references after graph navigation.",
    "Every major tool returns indexFresh, pendingFileCount, watcher, lastSyncAt, and lastSyncAtSource. Treat indexFresh=false conservatively and inspect stale files or run godot_sync.",
  ].join("\n");
}
