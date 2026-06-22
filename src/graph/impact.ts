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
  omitted: ImpactOmittedSummary;
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

export interface ImpactOmittedSummary {
  nodes: number;
  relationships: number;
}

const MAX_IMPACT_SCENES = 20;
const MAX_IMPACT_SCRIPTS = 30;
const MAX_IMPACT_RESOURCES = 25;
const MAX_IMPACT_RELATIONSHIPS = 40;
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
      omitted: { nodes: 0, relationships: 0 },
    };
  }

  const related: GraphNode[] = [target];
  const relationships: string[] = [];
  const selectedRelationships = new Set<string>();
  const graphEdges = visibleEdges(snapshot);

  for (const edge of [...incomingEdges(snapshot, target.id), ...outgoingEdges(snapshot, target.id)]) {
    addRelationship(relationships, selectedRelationships, explainEdge(edge));
    addRelatedNode(snapshot.nodes, related, edge.source === target.id ? edge.target : edge.source);
  }

  for (const ref of [...refsFrom(snapshot, target.id), ...refsMatching(snapshot, target.name)]) {
    addRelationship(relationships, selectedRelationships, explainUnresolvedRef(ref));
    addRelatedNode(snapshot.nodes, related, ref.fromNodeId);
  }

  addStructuralImpactContext(snapshot.nodes, graphEdges, related, relationships, selectedRelationships);
  const omitted = omittedBroadImpact(snapshot.nodes, graphEdges, target, related, selectedRelationships);

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
    omitted,
  };
}

function addRelationship(
  relationships: string[],
  selectedRelationships: Set<string>,
  relationship: string,
): void {
  if (selectedRelationships.has(relationship)) {
    return;
  }
  relationships.push(relationship);
  selectedRelationships.add(relationship);
}

function addRelatedNode(nodes: GraphNode[], related: GraphNode[], nodeId: string): boolean {
  if (related.some((node) => node.id === nodeId)) {
    return false;
  }
  const node = nodes.find((candidate) => candidate.id === nodeId);
  if (!node) {
    return false;
  }
  related.push(node);
  return true;
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

function addStructuralImpactContext(
  nodes: GraphNode[],
  edges: Array<{ source: string; target: string; kind: string; provenance?: string }>,
  related: GraphNode[],
  relationships: string[],
  selectedRelationships: Set<string>,
): void {
  let changed = true;
  while (changed) {
    changed = false;
    const ids = new Set(related.map((node) => node.id));
    for (const edge of edges) {
      if (edge.kind === "contains" && ids.has(edge.target)) {
        addRelationship(relationships, selectedRelationships, edgeToRelationship(edge));
        changed = addRelatedNode(nodes, related, edge.source) || changed;
      } else if (edge.kind === "attaches_script" && ids.has(edge.target)) {
        const source = nodes.find((node) => node.id === edge.source);
        if (source?.kind === "scene_node") {
          addRelationship(relationships, selectedRelationships, edgeToRelationship(edge));
          changed = addRelatedNode(nodes, related, edge.source) || changed;
        }
      }
    }
  }
}

function omittedBroadImpact(
  nodes: GraphNode[],
  edges: Array<{ source: string; target: string; kind: string; provenance?: string }>,
  target: GraphNode,
  selectedNodes: GraphNode[],
  selectedRelationships: Set<string>,
): ImpactOmittedSummary {
  const broadNodes: GraphNode[] = [...selectedNodes];
  const broadRelationships: string[] = [];
  const neighborhoodDepth = target.kind === "resource" || target.kind === "scene_node" ? 0 : 2;
  expandNeighborhood(nodes, edges, broadNodes, broadRelationships, neighborhoodDepth);

  const selectedNodeIds = new Set(selectedNodes.map((node) => node.id));
  return {
    nodes: uniqueNodes(broadNodes).filter((node) => !selectedNodeIds.has(node.id)).length,
    relationships: uniqueStrings(broadRelationships).filter((relationship) =>
      !selectedRelationships.has(relationship)
    ).length,
  };
}

function edgeToRelationship(edge: { source: string; target: string; kind: string; provenance?: string }): string {
  return `${edge.source} ${edge.kind} ${edge.target} (${edge.provenance ?? "graph"})`;
}
