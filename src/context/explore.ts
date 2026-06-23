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
import type { GraphNode, UnresolvedRef } from "../types.js";

export interface ContextQueryOptions {
  projectRoot: string;
  query?: string;
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
const WEAK_CONTEXT_TERMS = new Set([
  "base",
  "builder",
  "current",
  "record",
  "run",
]);
const IGNORED_CONTEXT_TERMS = new Set([
  "and",
  "for",
  "from",
  "into",
  "that",
  "the",
  "this",
  "with",
]);

export function exploreGodotContext(
  graph: GraphDatabase,
  options: ContextQueryOptions & { query: string },
): AgentContext {
  const seeds = selectContextSeeds(graph, options.query);
  return contextFromSeeds(graph, options.projectRoot, options.query, seeds, options);
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
    for (const ref of reverseUnresolvedRefsForSeed(snapshot, seed)) {
      relationships.push(explainUnresolvedRef(ref));
      const source = snapshot.nodes.find((node) => node.id === ref.fromNodeId);
      if (source) {
        related.push(source);
      }
    }
  }

  return finalizeContext(projectRoot, query, related, relationships, entryPointIds, pathsBetween, options);
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

  const queryTermWeights = weightedQueryTerms(query);
  const nodeTerms = nodeContextTerms(node);
  let matchedWeight = 0;
  let matchedCount = 0;
  for (const [term, weight] of queryTermWeights) {
    if (nodeTerms.has(term)) {
      matchedWeight += weight;
      matchedCount += 1;
    }
  }

  score += matchedWeight * 28;
  score += matchedCount * matchedCount * 8;

  if (matchedCount <= 2 && isLikelyUiSurface(node)) {
    score -= 30;
  }

  if (node.name && query.toLowerCase().includes(node.name.toLowerCase())) {
    score += 40;
  }

  return score + kindPriority(node.kind);
}

function weightedQueryTerms(query: string): Map<string, number> {
  const weights = new Map<string, number>();
  for (const rawTerm of identifierTerms(query)) {
    const term = normalizeContextTerm(rawTerm);
    if (!term || IGNORED_CONTEXT_TERMS.has(term)) {
      continue;
    }

    const weight = WEAK_CONTEXT_TERMS.has(term) ? 1 : 2;
    weights.set(term, Math.max(weights.get(term) ?? 0, weight));
  }
  return weights;
}

function nodeContextTerms(node: GraphNode): Set<string> {
  return new Set(
    [
      ...identifierTerms(node.name),
      ...identifierTerms(node.qualifiedName),
      ...identifierTerms(node.filePath ?? ""),
      ...identifierTerms(node.id),
    ]
      .map(normalizeContextTerm)
      .filter((term): term is string => term !== null),
  );
}

function identifierTerms(value: string): string[] {
  return value
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[^A-Za-z0-9]+/)
    .filter((term) => term.length >= 3);
}

function normalizeContextTerm(value: string): string | null {
  const term = value.toLowerCase();
  if (term.length < 3) {
    return null;
  }
  if (term.endsWith("ies") && term.length > 4) {
    return `${term.slice(0, -3)}y`;
  }
  if (term.endsWith("s") && term.length > 4) {
    return term.slice(0, -1);
  }
  return term;
}

function isLikelyUiSurface(node: GraphNode): boolean {
  return /\b(adapter|component|panel|snapshot|ui)\b/i.test(
    identifierTerms([node.name, node.qualifiedName, node.filePath ?? ""].join(" ")).join(" "),
  );
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
