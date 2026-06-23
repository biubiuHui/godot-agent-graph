export const NODE_KINDS = [
  "project",
  "file",
  "scene",
  "scene_node",
  "script_class",
  "inner_class",
  "method",
  "property",
  "signal",
  "resource",
  "autoload",
  "input_action",
] as const;

export type NodeKind = (typeof NODE_KINDS)[number];

export const EDGE_KINDS = [
  "contains",
  "attaches_script",
  "extends",
  "calls",
  "emits_signal",
  "connects_signal",
  "references_symbol",
  "references_nodepath",
  "loads_resource",
  "preloads_resource",
  "instantiates_scene",
  "uses_autoload",
  "uses_input_action",
  "main_scene",
] as const;

export type EdgeKind = (typeof EDGE_KINDS)[number];

export const FILE_KINDS = ["project", "gdscript", "scene", "resource"] as const;

export type FileKind = (typeof FILE_KINDS)[number];

export type JsonObject = Record<string, unknown>;

export interface GraphFile {
  path: string;
  kind: FileKind;
  contentHash: string;
  size: number;
  modifiedAt: number;
  indexedAt: number;
  nodeCount: number;
  parseErrors: string[];
}

export interface GraphNode {
  id: string;
  kind: NodeKind;
  name: string;
  qualifiedName: string;
  filePath: string | null;
  startLine: number | null;
  endLine: number | null;
  signature: string | null;
  metadata: JsonObject;
  updatedAt: number;
}

export interface GraphEdge {
  id?: number;
  source: string;
  target: string;
  kind: EdgeKind;
  line: number | null;
  column: number | null;
  provenance: string;
  metadata: JsonObject;
}

export interface UnresolvedRef {
  id?: number;
  fromNodeId: string;
  referenceName: string;
  referenceKind: string;
  filePath: string;
  line: number | null;
  column: number | null;
  resolved?: boolean;
  candidates: JsonObject[];
}

export interface ProjectMetadata {
  key: string;
  value: JsonObject;
  updatedAt: number;
}
