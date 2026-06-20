import { listEdges, listNodes, listUnresolvedRefs } from "../db/queries.js";
import type { GraphDatabase } from "../db/index.js";
import type { EdgeKind, GraphEdge, GraphNode, UnresolvedRef } from "../types.js";

export interface GraphSnapshot {
  nodes: GraphNode[];
  edges: GraphEdge[];
  unresolvedRefs: UnresolvedRef[];
}

export function loadGraphSnapshot(graph: GraphDatabase): GraphSnapshot {
  return {
    nodes: listNodes(graph),
    edges: listEdges(graph),
    unresolvedRefs: listUnresolvedRefs(graph),
  };
}

export function explainEdge(edge: GraphEdge): string {
  return `${edge.source} ${edge.kind} ${edge.target} (${edge.provenance})`;
}

export function explainUnresolvedRef(ref: UnresolvedRef): string {
  return `${ref.fromNodeId} ${ref.referenceKind} ${ref.referenceName} (unresolved)`;
}

export function uniqueNodes(nodes: GraphNode[]): GraphNode[] {
  const seen = new Set<string>();
  return nodes.filter((node) => {
    if (seen.has(node.id)) {
      return false;
    }
    seen.add(node.id);
    return true;
  });
}

export function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)];
}

export function prioritizeRelationships(values: string[]): string[] {
  return values
    .map((value, index) => ({ value, index, priority: relationshipPriority(value) }))
    .sort((left, right) => left.priority - right.priority || left.index - right.index)
    .map((item) => item.value);
}

function relationshipPriority(value: string): number {
  if (value.includes(" (unresolved)")) {
    return 60;
  }
  if (value.includes(" attaches_script ")) {
    return 10;
  }
  if (value.includes(" instantiates_scene ") || value.includes(" main_scene ")) {
    return 15;
  }
  if (
    value.includes(" calls ") ||
    value.includes(" emits_signal ") ||
    value.includes(" connects_signal ")
  ) {
    return 20;
  }
  if (
    value.includes(" uses_autoload ") ||
    value.includes(" uses_input_action ") ||
    value.includes(" references_nodepath ")
  ) {
    return 25;
  }
  if (value.includes("loads_resource ") || value.includes("preloads_resource ")) {
    return 30;
  }
  if (value.includes(" extends ")) {
    return 35;
  }
  if (value.includes(" contains method:") || value.includes(" contains property:")) {
    return 80;
  }
  if (value.includes(" contains ")) {
    return 70;
  }
  return 50;
}

export function incomingEdges(snapshot: GraphSnapshot, nodeId: string): GraphEdge[] {
  return visibleEdges(snapshot).filter((edge) => edge.target === nodeId);
}

export function outgoingEdges(snapshot: GraphSnapshot, nodeId: string): GraphEdge[] {
  return visibleEdges(snapshot).filter((edge) => edge.source === nodeId);
}

export function visibleEdges(snapshot: GraphSnapshot): GraphEdge[] {
  return snapshot.edges.filter((edge) => !isSupersededResourceEdge(snapshot, edge));
}

export function refsFrom(snapshot: GraphSnapshot, nodeId: string): UnresolvedRef[] {
  return snapshot.unresolvedRefs.filter(
    (ref) => ref.fromNodeId === nodeId && !isResolvedRef(snapshot, ref),
  );
}

export function refsMatching(snapshot: GraphSnapshot, referenceName: string): UnresolvedRef[] {
  return snapshot.unresolvedRefs.filter(
    (ref) => ref.referenceName === referenceName && !isResolvedRef(snapshot, ref),
  );
}

export function isResolvedRef(snapshot: GraphSnapshot, ref: UnresolvedRef): boolean {
  const resolvedKinds = resolvedEdgeKinds(ref);
  if (resolvedKinds.length === 0) {
    return false;
  }

  return snapshot.edges.some((edge) => {
    if (edge.source !== ref.fromNodeId || !resolvedKinds.includes(edge.kind)) {
      return false;
    }

    const target = snapshot.nodes.find((node) => node.id === edge.target);
    return target ? nodeMatchesRef(target, ref) : false;
  });
}

function resolvedEdgeKinds(ref: UnresolvedRef): EdgeKind[] {
  if (ref.referenceKind === "autoload_resource") {
    return ["loads_resource"];
  }

  if (ref.referenceKind === "references_nodepath" && isRootNodePathRef(ref)) {
    return ["references_nodepath", "uses_autoload"];
  }

  if (
    ref.referenceKind === "calls" ||
    ref.referenceKind === "connects_signal" ||
    ref.referenceKind === "emits_signal" ||
    ref.referenceKind === "extends" ||
    ref.referenceKind === "loads_resource" ||
    ref.referenceKind === "main_scene" ||
    ref.referenceKind === "preloads_resource" ||
    ref.referenceKind === "references_nodepath" ||
    ref.referenceKind === "uses_autoload" ||
    ref.referenceKind === "uses_input_action"
  ) {
    return [ref.referenceKind];
  }

  return [];
}

function nodeMatchesRef(node: GraphNode, ref: UnresolvedRef): boolean {
  if (node.name === ref.referenceName || node.qualifiedName === ref.referenceName) {
    return true;
  }

  if (node.filePath === ref.referenceName || node.id.endsWith(`:${ref.referenceName}`)) {
    return true;
  }

  if (ref.referenceKind === "references_nodepath") {
    const autoloadName = autoloadNameFromNodePathRef(ref);
    if (node.kind === "autoload" && node.name === autoloadName) {
      return true;
    }

    return node.id.endsWith(`:${ref.referenceName}`) || node.id.endsWith(`/${ref.referenceName}`);
  }

  return false;
}

function isRootNodePathRef(ref: UnresolvedRef): boolean {
  return ref.candidates.some((candidate) => candidate.kind === "root_get_node");
}

function autoloadNameFromNodePathRef(ref: UnresolvedRef): string | null {
  if (!isRootNodePathRef(ref)) {
    return null;
  }

  if (ref.referenceName.startsWith("/root/")) {
    return ref.referenceName.slice("/root/".length).split("/")[0] ?? null;
  }

  return ref.referenceName.split("/")[0] ?? null;
}

function isSupersededResourceEdge(snapshot: GraphSnapshot, edge: GraphEdge): boolean {
  if (
    edge.provenance !== "resource-parser" ||
    (
      edge.kind !== "attaches_script" &&
      edge.kind !== "instantiates_scene" &&
      edge.kind !== "loads_resource"
    )
  ) {
    return false;
  }

  const resource = snapshot.nodes.find((node) => node.id === edge.target);
  if (resource?.kind !== "resource" || !resource.filePath) {
    return false;
  }

  if (edge.kind === "loads_resource") {
    if (!resource.filePath.endsWith(".gd")) {
      return false;
    }

    return (
      hasResolvedEdgeToFile(snapshot, edge.source, "attaches_script", resource.filePath) ||
      hasContainedResolvedEdgeToFile(snapshot, edge.source, "attaches_script", resource.filePath)
    );
  }

  return hasResolvedEdgeToFile(snapshot, edge.source, edge.kind, resource.filePath);
}

function hasResolvedEdgeToFile(
  snapshot: GraphSnapshot,
  source: string,
  kind: EdgeKind,
  filePath: string,
): boolean {
  return snapshot.edges.some((candidate) => {
    if (
      candidate.source !== source ||
      candidate.kind !== kind ||
      candidate.provenance !== "resolver"
    ) {
      return false;
    }

    const target = snapshot.nodes.find((node) => node.id === candidate.target);
    return target?.filePath === filePath;
  });
}

function hasContainedResolvedEdgeToFile(
  snapshot: GraphSnapshot,
  container: string,
  kind: EdgeKind,
  filePath: string,
): boolean {
  const containedIds = new Set(
    snapshot.edges
      .filter((edge) => edge.source === container && edge.kind === "contains")
      .map((edge) => edge.target),
  );

  return snapshot.edges.some((edge) => (
    containedIds.has(edge.source) &&
    edge.kind === kind &&
    edge.provenance === "resolver" &&
    snapshot.nodes.find((node) => node.id === edge.target)?.filePath === filePath
  ));
}
