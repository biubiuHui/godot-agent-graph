import type { GraphNode } from "../types.js";

export function findUniqueMethodByName(nodes: GraphNode[], name: string): GraphNode | null {
  const matches = nodes.filter((node) => node.kind === "method" && node.name === name);
  return matches.length === 1 ? matches[0] ?? null : null;
}
