import type { GraphNode } from "../types.js";

export interface GodotPathIndexes {
  byId: Map<string, GraphNode>;
  byName: Map<string, GraphNode[]>;
  resourcesByPath: Map<string, GraphNode>;
  scenesByPath: Map<string, GraphNode>;
  scriptsByPath: Map<string, GraphNode>;
  autoloadsByName: Map<string, GraphNode>;
  inputActionsByName: Map<string, GraphNode>;
}

export function buildGodotPathIndexes(nodes: GraphNode[]): GodotPathIndexes {
  const indexes: GodotPathIndexes = {
    byId: new Map(),
    byName: new Map(),
    resourcesByPath: new Map(),
    scenesByPath: new Map(),
    scriptsByPath: new Map(),
    autoloadsByName: new Map(),
    inputActionsByName: new Map(),
  };

  for (const node of nodes) {
    indexes.byId.set(node.id, node);
    const named = indexes.byName.get(node.name) ?? [];
    named.push(node);
    indexes.byName.set(node.name, named);

    if (node.kind === "resource") {
      indexes.resourcesByPath.set(node.qualifiedName, node);
    } else if (node.kind === "scene") {
      indexes.scenesByPath.set(node.qualifiedName, node);
    } else if (node.kind === "script_class" && node.filePath) {
      indexes.scriptsByPath.set(node.filePath, node);
      indexes.byName.set(node.name, [node, ...(indexes.byName.get(node.name) ?? []).filter((item) => item.id !== node.id)]);
    } else if (node.kind === "autoload") {
      indexes.autoloadsByName.set(node.name, node);
    } else if (node.kind === "input_action") {
      indexes.inputActionsByName.set(node.name, node);
    }
  }

  return indexes;
}

export function resourcePathFromNodeId(nodeId: string): string | null {
  return nodeId.startsWith("resource:") ? nodeId.slice("resource:".length) : null;
}
