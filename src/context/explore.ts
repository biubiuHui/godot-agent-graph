import type { GraphDatabase } from "../db/index.js";
import { collectFilePaths, sourceSnippetsForFiles, type SourceSnippet } from "./formatter.js";
import { collectCandidatePools } from "./candidate-pools.js";
import { buildQueryPlan, type ContextStrategy } from "./query-plan.js";
import { selectRankedSeeds } from "./ranked-selection.js";
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
} from "../graph/traversal.js";
import type { GraphNode, UnresolvedRef } from "../types.js";
import { addressForNode } from "../graph/node-address.js";

export type { ContextStrategy } from "./query-plan.js";

export interface ContextQueryOptions {
  projectRoot: string;
  query?: string;
  maxFiles?: number;
  includeCode?: boolean;
}

export interface AgentContext {
  query: string;
  strategy: ContextStrategy;
  completeness: AgentContextCompleteness;
  entryPoints: string[];
  pathsBetween: string[];
  blastRadius?: AgentBlastRadius;
  nodes: AgentNodeSummary[];
  relationships: string[];
  files: string[];
  snippets: SourceSnippet[];
}

export interface AgentContextCompleteness {
  scope: "bounded_navigation" | "relationship_summary" | "source_window";
  complete: boolean;
}

export interface AgentBlastRadius {
  entryPoints: string[];
  checkFiles: string[];
  relationshipCount: number;
}

interface ContextSeedSelection {
  strategy: ContextStrategy;
  seeds: GraphNode[];
  resourceAnchorFiles: string[];
}

export interface AgentNodeSummary {
  id: string;
  kind: string;
  name: string;
  qualifiedName: string;
  filePath: string | null;
  addressKind: GraphNode["addressKind"];
  ownerPath: string | null;
  readablePath: string | null;
  displayPath: string | null;
  referencePath: string | null;
  selector: Record<string, string | null>;
  startLine: number | null;
  signature: string | null;
}

const MAX_CONTEXT_NODES = 60;
const MAX_CONTEXT_RELATIONSHIPS = 80;
const MAX_RESOURCE_NODES_PER_FILE = 2;

export function exploreGodotContext(
  graph: GraphDatabase,
  options: ContextQueryOptions & { query: string },
): AgentContext {
  const selection = selectContextSeeds(graph, options.query);
  return contextFromSeeds(graph, options.projectRoot, options.query, selection, options);
}

function contextFromSeeds(
  graph: GraphDatabase,
  projectRoot: string,
  query: string,
  selection: ContextSeedSelection,
  options: ContextQueryOptions,
): AgentContext {
  const { seeds, strategy } = selection;
  const snapshot = loadGraphSnapshot(graph);
  const related: GraphNode[] = [...seeds];
  const relationships: string[] = [];
  const entryPointIds = new Set(seeds.map((seed) => seed.id));
  const resourceAnchorFiles = new Set(selection.resourceAnchorFiles);
  const pathsBetween = focusedPathsBetween(snapshot, entryPointIds);

  for (const seed of seeds) {
    for (const edge of [...incomingEdges(snapshot, seed.id), ...outgoingEdges(snapshot, seed.id)]) {
      const otherId = edge.source === seed.id ? edge.target : edge.source;
      const other = snapshot.nodes.find((node) => node.id === otherId);
      if (other && shouldIncludeAnchoredRelatedNode(resourceAnchorFiles, other)) {
        relationships.push(explainEdge(edge));
        related.push(other);
      }
    }
    for (const ref of refsFrom(snapshot, seed.id)) {
      relationships.push(explainUnresolvedRef(ref));
    }
    if (resourceAnchorFiles.size === 0) {
      for (const ref of reverseUnresolvedRefsForSeed(snapshot, seed)) {
        relationships.push(explainUnresolvedRef(ref));
        const source = snapshot.nodes.find((node) => node.id === ref.fromNodeId);
        if (source) {
          related.push(source);
        }
      }
    }
  }

  return finalizeContext(projectRoot, query, strategy, related, relationships, entryPointIds, pathsBetween, options);
}

function shouldIncludeAnchoredRelatedNode(resourceAnchorFiles: ReadonlySet<string>, node: GraphNode): boolean {
  if (resourceAnchorFiles.size === 0) {
    return true;
  }
  if (node.kind !== "resource") {
    return true;
  }
  return node.filePath !== null && resourceAnchorFiles.has(node.filePath);
}

function reverseUnresolvedRefsForSeed(
  snapshot: ReturnType<typeof loadGraphSnapshot>,
  seed: GraphNode,
): UnresolvedRef[] {
  const names = uniqueStrings([seed.name, seed.qualifiedName].filter((name) => name.length > 0));
  return uniqueUnresolvedRefs(names.flatMap((name) => refsMatching(snapshot, name)))
    .filter((ref) => ref.fromNodeId !== seed.id);
}

function uniqueUnresolvedRefs(refs: UnresolvedRef[]): UnresolvedRef[] {
  const seen = new Set<string>();
  return refs.filter((ref) => {
    const key = [
      ref.fromNodeId,
      ref.referenceKind,
      ref.referenceName,
      ref.filePath,
      ref.line ?? "",
      ref.column ?? "",
    ].join("\0");
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function finalizeContext(
  projectRoot: string,
  query: string,
  strategy: ContextStrategy,
  nodes: GraphNode[],
  relationships: string[],
  entryPointIds: Set<string>,
  pathsBetween: string[],
  options: ContextQueryOptions,
): AgentContext {
  const unique = limitResourceNodesPerFile(uniqueNodes(nodes)).slice(0, MAX_CONTEXT_NODES);
  const visibleNodeIds = new Set(unique.map((node) => node.id));
  const files = collectFilePaths(unique, options.maxFiles ?? 6);
  const entryPoints = [...entryPointIds].filter((id) => visibleNodeIds.has(id));
  return {
    query,
    strategy,
    completeness: completenessForStrategy(strategy),
    entryPoints,
    pathsBetween,
    ...(isEditIntent(query)
      ? {
          blastRadius: {
            entryPoints,
            checkFiles: files,
            relationshipCount: relationships.length,
          },
        }
      : {}),
    nodes: unique.map(summarizeAgentNode),
    relationships: prioritizeRelationships(uniqueStrings(relationships)).slice(0, MAX_CONTEXT_RELATIONSHIPS),
    files,
    snippets: sourceSnippetsForFiles(projectRoot, files, {
      includeCode: options.includeCode ?? true,
      maxLinesPerFile: 20,
    }),
  };
}

function isEditIntent(query: string): boolean {
  return /\b(edit|change|modify|impact|refactor|delete|rename|fix)\b/i.test(query);
}

function completenessForStrategy(strategy: ContextStrategy): AgentContextCompleteness {
  if (strategy === "relationship") {
    return {
      scope: "relationship_summary",
      complete: false,
    };
  }

  if (strategy === "source-oriented") {
    return {
      scope: "source_window",
      complete: false,
    };
  }

  return {
    scope: "bounded_navigation",
    complete: false,
  };
}

function focusedPathsBetween(snapshot: ReturnType<typeof loadGraphSnapshot>, entryPointIds: Set<string>): string[] {
  if (entryPointIds.size < 2) {
    return [];
  }

  const directEdges = visibleEdges(snapshot).filter(
    (edge) => entryPointIds.has(edge.source) && entryPointIds.has(edge.target),
  );
  const meaningfulEdges = directEdges.filter((edge) => edge.kind !== "contains");
  const selected = meaningfulEdges.length > 0 ? meaningfulEdges : directEdges;
  return prioritizeRelationships(uniqueStrings(selected.map(explainEdge))).slice(0, 12);
}

function selectContextSeeds(graph: GraphDatabase, query: string): ContextSeedSelection {
  const plan = buildQueryPlan(query);
  const snapshot = plan.strategy === "relationship" ? loadGraphSnapshot(graph) : null;
  const pools = collectCandidatePools(graph, plan);
  return selectRankedSeeds(plan, pools, snapshot);
}

function limitResourceNodesPerFile(nodes: GraphNode[]): GraphNode[] {
  const resourcesByFile = new Map<string, GraphNode[]>();
  for (const node of nodes) {
    if (node.kind !== "resource") {
      continue;
    }

    const key = node.filePath ?? node.qualifiedName;
    resourcesByFile.set(key, [...(resourcesByFile.get(key) ?? []), node]);
  }

  const allowedResourceIds = new Set<string>();
  for (const resourceNodes of resourcesByFile.values()) {
    let allowedForFile = 0;
    for (const node of [...resourceNodes].sort(resourceNodeSort)) {
      if (allowedForFile >= MAX_RESOURCE_NODES_PER_FILE) {
        break;
      }
      allowedResourceIds.add(node.id);
      allowedForFile += 1;
    }
  }

  return nodes.filter((node) => node.kind !== "resource" || allowedResourceIds.has(node.id));
}

function resourceNodeSort(left: GraphNode, right: GraphNode): number {
  return resourceNodePriority(left) - resourceNodePriority(right);
}

function resourceNodePriority(node: GraphNode): number {
  if (node.addressKind === "resource_main" || (node.filePath && node.qualifiedName === node.filePath)) {
    return 0;
  }
  return 1;
}

function summarizeAgentNode(node: GraphNode): AgentNodeSummary {
  const address = addressForNode(node);
  return {
    id: node.id,
    kind: node.kind,
    name: node.name,
    qualifiedName: node.qualifiedName,
    filePath: node.filePath,
    addressKind: address.kind,
    ownerPath: address.ownerPath,
    readablePath: address.readablePath,
    displayPath: address.displayPath,
    referencePath: address.referencePath,
    selector: address.selector,
    startLine: node.startLine,
    signature: node.signature,
  };
}
