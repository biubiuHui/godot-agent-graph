import type { GraphNode } from "../types.js";

export function findSceneNodeByPath(nodes: GraphNode[], sceneFilePath: string, nodePath: string): GraphNode | null {
  const id = `scene_node:${sceneFilePath}:${nodePath}`;
  return nodes.find((node) => node.id === id) ?? null;
}
