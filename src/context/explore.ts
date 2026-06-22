import type { GraphDatabase } from "../db/index.js";
import { searchNodes } from "../db/queries.js";
import { collectFilePaths, sourceSnippetsForFiles, type SourceSnippet } from "./formatter.js";
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
import type { GraphNode } from "../types.js";

export interface ContextQueryOptions {
  projectRoot: string;
  query?: string;
  symbol?: string;
  maxFiles?: number;
  includeCode?: boolean;
}

export interface AgentContext {
  query: string;
  entryPoints: string[];
  pathsBetween: string[];
  blastRadius?: AgentBlastRadius;
  nodes: AgentNodeSummary[];
  relationships: string[];
  files: string[];
  snippets: SourceSnippet[];
}

export interface AgentBlastRadius {
  entryPoints: string[];
  checkFiles: string[];
  relationshipCount: number;
}

export interface AgentNodeSummary {
  id: string;
  kind: string;
  name: string;
  qualifiedName: string;
  filePath: string | null;
  startLine: number | null;
  signature: string | null;
}

const MAX_CONTEXT_NODES = 60;
const MAX_CONTEXT_RELATIONSHIPS = 80;

export function exploreGodotContext(
  graph: GraphDatabase,
  options: ContextQueryOptions & { query: string },
): AgentContext {
  const seeds = selectContextSeeds(graph, options.query);
  return contextFromSeeds(graph, options.projectRoot, options.query, seeds, options);
}

export function getSymbolContext(
  graph: GraphDatabase,
  options: ContextQueryOptions & { symbol: string },
): AgentContext {
  const seeds = searchNodes(graph, options.symbol, 10);
  return contextFromSeeds(graph, options.projectRoot, options.symbol, seeds, options);
}

export function getCallersContext(
  graph: GraphDatabase,
  options: ContextQueryOptions & { symbol: string },
): AgentContext {
  const snapshot = loadGraphSnapshot(graph);
  const targets = searchNodes(graph, options.symbol, 10);
  const relationships: string[] = [];
  const related: GraphNode[] = [...targets];

  for (const target of targets) {
    for (const edge of incomingEdges(snapshot, target.id)) {
      relationships.push(explainEdge(edge));
      const source = snapshot.nodes.find((node) => node.id === edge.source);
      if (source) {
        related.push(source);
      }
    }
    for (const ref of refsMatching(snapshot, target.name)) {
      const source = snapshot.nodes.find((node) => node.id === ref.fromNodeId);
      relationships.push(explainUnresolvedRef(ref));
      if (source) {
        related.push(source);
      }
    }
  }

  return finalizeContext(
    options.projectRoot,
    options.symbol,
    related,
    relationships,
    new Set(targets.map((target) => target.id)),
    [],
    options,
  );
}

export function getCalleesContext(
  graph: GraphDatabase,
  options: ContextQueryOptions & { symbol: string },
): AgentContext {
  const snapshot = loadGraphSnapshot(graph);
  const seeds = searchNodes(graph, options.symbol, 5);
  const related: GraphNode[] = [...seeds];
  const relationships: string[] = [];

  for (const seed of seeds) {
    for (const edge of outgoingEdges(snapshot, seed.id)) {
      relationships.push(explainEdge(edge));
      const target = snapshot.nodes.find((node) => node.id === edge.target);
      if (target) {
        related.push(target);
      }
    }
    for (const ref of refsFrom(snapshot, seed.id)) {
      relationships.push(explainUnresolvedRef(ref));
    }
  }

  return finalizeContext(
    options.projectRoot,
    options.symbol,
    related,
    relationships,
    new Set(seeds.map((seed) => seed.id)),
    [],
    options,
  );
}

function contextFromSeeds(
  graph: GraphDatabase,
  projectRoot: string,
  query: string,
  seeds: GraphNode[],
  options: ContextQueryOptions,
): AgentContext {
  const snapshot = loadGraphSnapshot(graph);
  const related: GraphNode[] = [...seeds];
  const relationships: string[] = [];
  const entryPointIds = new Set(seeds.map((seed) => seed.id));
  const pathsBetween = focusedPathsBetween(snapshot, entryPointIds);

  for (const seed of seeds) {
    for (const edge of [...incomingEdges(snapshot, seed.id), ...outgoingEdges(snapshot, seed.id)]) {
      relationships.push(explainEdge(edge));
      const otherId = edge.source === seed.id ? edge.target : edge.source;
      const other = snapshot.nodes.find((node) => node.id === otherId);
      if (other) {
        related.push(other);
      }
    }
    for (const ref of refsFrom(snapshot, seed.id)) {
      relationships.push(explainUnresolvedRef(ref));
    }
  }

  return finalizeContext(projectRoot, query, related, relationships, entryPointIds, pathsBetween, options);
}

function finalizeContext(
  projectRoot: string,
  query: string,
  nodes: GraphNode[],
  relationships: string[],
  entryPointIds: Set<string>,
  pathsBetween: string[],
  options: ContextQueryOptions,
): AgentContext {
  const unique = uniqueNodes(nodes).slice(0, MAX_CONTEXT_NODES);
  const visibleNodeIds = new Set(unique.map((node) => node.id));
  const files = collectFilePaths(unique, options.maxFiles ?? 6);
  const entryPoints = [...entryPointIds].filter((id) => visibleNodeIds.has(id));
  return {
    query,
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

function selectContextSeeds(graph: GraphDatabase, query: string): GraphNode[] {
  const fullQueryMatches = searchNodes(graph, query, 10);
  const exactTerms = extractContextTerms(query);
  const exactTermSet = new Set(exactTerms);
  const candidates = uniqueNodes([
    ...fullQueryMatches,
    ...exactTerms.flatMap((term) => searchNodes(graph, term, 5)),
  ]);

  return candidates
    .map((node, index) => ({
      node,
      index,
      score: contextSeedScore(node, query, exactTermSet),
    }))
    .sort((left, right) => right.score - left.score || left.index - right.index)
    .map((item) => item.node)
    .slice(0, 12);
}

function extractContextTerms(query: string): string[] {
  const pathTerms = query.match(/res:\/\/[^\s"',)]+/g) ?? [];
  const symbolTerms = query.match(/[A-Za-z_][A-Za-z0-9_]*/g) ?? [];
  return uniqueStrings(
    [...pathTerms, ...symbolTerms].filter((term) =>
      term.startsWith("res://") ||
      term.includes("_") ||
      /[a-z][A-Z]/.test(term) ||
      /^[A-Z][A-Za-z0-9_]*$/.test(term),
    ),
  );
}

function contextSeedScore(node: GraphNode, query: string, exactTerms: Set<string>): number {
  let score = 0;
  for (const term of exactTerms) {
    if (node.name === term || node.qualifiedName === term || node.filePath === term || node.id === term) {
      score += 200;
    } else if (
      node.name.includes(term) ||
      node.qualifiedName.includes(term) ||
      node.filePath?.includes(term) ||
      node.id.includes(term)
    ) {
      score += 80;
    }
  }

  if (node.name && query.includes(node.name)) {
    score += 40;
  }

  return score + kindPriority(node.kind);
}

function kindPriority(kind: string): number {
  if (kind === "script_class" || kind === "scene") {
    return 30;
  }
  if (kind === "autoload" || kind === "scene_node") {
    return 25;
  }
  if (kind === "method" || kind === "signal") {
    return 20;
  }
  if (kind === "resource") {
    return 10;
  }
  return 0;
}

function summarizeAgentNode(node: GraphNode): AgentNodeSummary {
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
