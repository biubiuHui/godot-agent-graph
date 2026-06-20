import type { GraphDatabase } from "../db/index.js";
import { searchNodes } from "../db/queries.js";
import type { GraphNode } from "../types.js";

export function searchGraph(
  graph: GraphDatabase,
  query: string,
  limit = 20,
): GraphNode[] {
  return searchNodes(graph, query, limit);
}
