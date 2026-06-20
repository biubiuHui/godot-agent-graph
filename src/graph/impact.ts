import { listNodes, searchNodes } from "../db/queries.js";
import type { GraphDatabase } from "../db/index.js";
import type { GraphNode } from "../types.js";
import {
  explainEdge,
  explainUnresolvedRef,
  incomingEdges,
  loadGraphSnapshot,
  outgoingEdges,
  prioritizeRelationships,
  refsFrom,
  refsMatching,
  uniqueNodes,
  uniqueStrings,
  visibleEdges,
} from "./traversal.js";

export interface ImpactContext {
  target: ImpactNodeSummary | null;
  affectedScenes: ImpactNodeSummary[];
  affectedScripts: ImpactNodeSummary[];
  affectedResources: ImpactNodeSummary[];
  relationships: string[];
  recommendedCheckFiles: string[];
}

export interface ImpactNodeSummary {
  id: string;
  kind: string;
  name: string;
  qualifiedName: string;
  filePath: string | null;
  startLine: number | null;
  signature: string | null;
}

const MAX_IMPACT_SCENES = 20;
const MAX_IMPACT_SCRIPTS = 30;
const MAX_IMPACT_RESOURCES = 25;
const MAX_IMPACT_RELATIONSHIPS = 120;
const MAX_IMPACT_CHECK_FILES = 20;

export function getImpactContext(graph: GraphDatabase, targetQuery: string): ImpactContext {
  const snapshot = loadGraphSnapshot(graph);
  const target = findImpactTarget(graph, targetQuery);
  if (!target) {
    return {
      target: null,
      affectedScenes: [],
      affectedScripts: [],
      affectedResources: [],
      relationships: [],
      recommendedCheckFiles: [],
    };
  }

  const related: GraphNode[] = [target];
  const relationships: string[] = [];

  for (const edge of [...incomingEdges(snapshot, target.id), ...outgoingEdges(snapshot, target.id)]) {
    relationships.push(explainEdge(edge));
    const other = snapshot.nodes.find((node) => node.id === (edge.source === target.id ? edge.target : edge.source));
    if (other) {
      related.push(other);
    }
  }

  for (const ref of [...refsFrom(snapshot, target.id), ...refsMatching(snapshot, target.name)]) {
    relationships.push(explainUnresolvedRef(ref));
    const source = snapshot.nodes.find((node) => node.id === ref.fromNodeId);
    if (source) {
      related.push(source);
    }
  }

  const graphEdges = visibleEdges(snapshot);
  const neighborhoodDepth = target.kind === "resource" || target.kind === "scene_node" ? 0 : 2;
  expandNeighborhood(snapshot.nodes, graphEdges, related, relationships, neighborhoodDepth);
  expandSceneContainers(snapshot.nodes, graphEdges, related);

  const unique = uniqueNodes(related);
  const affected = unique.filter((node) => node.id !== target.id);
  const affectedScenes = affected.filter((node) => node.kind === "scene").slice(0, MAX_IMPACT_SCENES);
  const affectedScripts = affected.filter((node) => node.kind === "script_class").slice(0, MAX_IMPACT_SCRIPTS);
  const affectedResources = affected.filter((node) => node.kind === "resource").slice(0, MAX_IMPACT_RESOURCES);
  const recommendedCheckFiles = uniqueStrings(
    unique.flatMap((node) => (node.filePath ? [node.filePath] : [])),
  ).slice(0, MAX_IMPACT_CHECK_FILES);

  return {
    target: summarizeImpactNode(target),
    affectedScenes: affectedScenes.map(summarizeImpactNode),
    affectedScripts: affectedScripts.map(summarizeImpactNode),
    affectedResources: affectedResources.map(summarizeImpactNode),
    relationships: prioritizeRelationships(uniqueStrings(relationships)).slice(0, MAX_IMPACT_RELATIONSHIPS),
    recommendedCheckFiles,
  };
}

function summarizeImpactNode(node: GraphNode): ImpactNodeSummary {
  return {
    id: node.id,
    kind: node.kind,
    name: node.name,
    qualifiedName: node.qualifiedName,
    filePath: node.filePath,
    startLine: node.startLine,
    signature: node.signature,
  };
}

function findImpactTarget(graph: GraphDatabase, targetQuery: string): GraphNode | null {
  if (targetQuery.startsWith("res://")) {
    const nodes = listNodes(graph);
    return (
      nodes.find((node) => node.filePath === targetQuery && node.kind === "script_class") ??
      nodes.find((node) => node.qualifiedName === targetQuery) ??
      nodes.find((node) => node.filePath === targetQuery) ??
      null
    );
  }

  return searchNodes(graph, targetQuery, 1)[0] ?? null;
}

function expandNeighborhood(
  nodes: GraphNode[],
  edges: Array<{ source: string; target: string; kind: string; provenance?: string }>,
  related: GraphNode[],
  relationships: string[],
  depth: number,
): void {
  for (let step = 0; step < depth; step += 1) {
    const ids = new Set(related.map((node) => node.id));
    for (const edge of edges) {
      if (!ids.has(edge.source) && !ids.has(edge.target)) {
        continue;
      }
      relationships.push(`${edge.source} ${edge.kind} ${edge.target} (${edge.provenance ?? "graph"})`);
      const otherId = ids.has(edge.source) ? edge.target : edge.source;
      const other = nodes.find((node) => node.id === otherId);
      if (other && !ids.has(other.id)) {
        related.push(other);
      }
    }
  }
}

function expandSceneContainers(
  nodes: GraphNode[],
  edges: Array<{ source: string; target: string; kind: string }>,
  related: GraphNode[],
): void {
  let changed = true;
  while (changed) {
    changed = false;
    const ids = new Set(related.map((node) => node.id));
    for (const edge of edges) {
      if (edge.kind !== "contains" || !ids.has(edge.target) || ids.has(edge.source)) {
        continue;
      }
      const source = nodes.find((node) => node.id === edge.source);
      if (source) {
        related.push(source);
        changed = true;
      }
    }
  }
}
