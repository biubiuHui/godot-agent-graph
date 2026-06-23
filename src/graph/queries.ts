import type { GraphDatabase } from "../db/index.js";
import {
  countEdges,
  countNodes,
  countUnresolvedRefs,
  getProjectMetadata,
} from "../db/queries.js";
import type { GraphFile } from "../types.js";

interface FileRow {
  path: string;
  kind: GraphFile["kind"];
  content_hash: string;
  size: number;
  modified_at: number;
  indexed_at: number;
  node_count: number;
  parse_errors: string;
}

export interface ProjectOverview {
  fileCount: number;
  nodeCount: number;
  edgeCount: number;
  unresolvedRefCount: number;
  project: Record<string, unknown> | null;
}

export function getProjectOverview(graph: GraphDatabase): ProjectOverview {
  const metadata = getProjectMetadata(graph, "index");
  const value = metadata?.value ?? {};

  return {
    fileCount: listIndexedFiles(graph).length,
    nodeCount: countNodes(graph),
    edgeCount: countEdges(graph),
    unresolvedRefCount: countUnresolvedRefs(graph),
    project: getObject(value, "project"),
  };
}

export function listIndexedFiles(graph: GraphDatabase): GraphFile[] {
  const rows = graph.sqlite
    .prepare("select * from files order by path")
    .all() as FileRow[];

  return rows.map((row) => ({
    path: row.path,
    kind: row.kind,
    contentHash: row.content_hash,
    size: row.size,
    modifiedAt: row.modified_at,
    indexedAt: row.indexed_at,
    nodeCount: row.node_count,
    parseErrors: JSON.parse(row.parse_errors) as string[],
  }));
}

function getObject(value: Record<string, unknown>, key: string): Record<string, unknown> | null {
  const field = value[key];
  return typeof field === "object" && field !== null && !Array.isArray(field)
    ? (field as Record<string, unknown>)
    : null;
}
