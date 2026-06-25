import type { GraphNode } from "../types.js";

export interface NodeAddress {
  kind: GraphNode["addressKind"];
  ownerPath: string | null;
  readablePath: string | null;
  displayPath: string | null;
  referencePath: string | null;
  selector: Record<string, string | null>;
}

export function addressForNode(node: GraphNode): NodeAddress {
  return {
    kind: node.addressKind,
    ownerPath: node.ownerPath,
    readablePath: node.readablePath,
    displayPath: node.displayPath,
    referencePath: node.referencePath,
    selector: selectorForNode(node),
  };
}

export function canReadNode(node: GraphNode): boolean {
  return readablePathForNode(node) !== null;
}

export function readablePathForNode(node: GraphNode): string | null {
  return node.readablePath;
}

export function displayPathForNode(node: GraphNode): string | null {
  return node.displayPath;
}

export function referencePathForNode(node: GraphNode): string | null {
  return node.referencePath;
}

export function selectorForNode(node: GraphNode): Record<string, string | null> {
  const path = node.displayPath ?? node.readablePath ?? node.ownerPath ?? node.referencePath;
  return {
    id: node.id,
    ...(node.addressKind !== "opaque" ? { kind: node.kind } : {}),
    ...(path ? { path } : {}),
  };
}
