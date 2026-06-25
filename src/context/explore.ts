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
const MAX_CONTEXT_SEEDS = 12;
const MAX_RESOURCE_SEEDS_PER_FILE = 2;
const MAX_RESOURCE_NODES_PER_FILE = 2;
const EXACT_CODE_SEED_INSERT_AFTER = 3;
const MAX_EXACT_CODE_SEEDS = 4;
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

  return finalizeContext(projectRoot, query, strategy, related, relationships, entryPointIds, pathsBetween, options);
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

function classifyContextQuery(query: string): ContextStrategy {
  if (/\b(dependents?|dependencies|references?|refs?|callers?|callees?|impact)\b/i.test(query)) {
    return "relationship";
  }

  if (/\bres:\/\/[^\s"',)]+\.gd\b|\b(offset|source|snippet|window)\b/i.test(query)) {
    return "source-oriented";
  }

  if (
    /\bres:\/\/[^\s"',)]+\.(?:tres|res|tscn)\b|\.(?:tres|res|tscn)\b|\bresources?\b|\b(display_name|display_label|payload|weights?|metadata)\b/i
      .test(query)
  ) {
    return "resource-first";
  }

  if (/[A-Z][A-Za-z0-9_]*|[A-Z0-9_]{3,}|[a-z]+_[a-z0-9_]+/.test(query)) {
    return "symbol-first";
  }

  return "general";
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

function diversifyContextSeeds(
  ranked: GraphNode[],
  exactTerms: Set<string>,
  strategy: ContextStrategy,
): GraphNode[] {
  const capped = capResourceSeedsPerFile(ranked);
  const exactCodeSeeds = strategy === "resource-first"
    ? []
    : ranked
        .filter((node) => isExactCodeSeed(node, exactTerms))
        .slice(0, MAX_EXACT_CODE_SEEDS);

  return uniqueNodes([
    ...capped.slice(0, EXACT_CODE_SEED_INSERT_AFTER),
    ...exactCodeSeeds,
    ...capped,
  ]).slice(0, MAX_CONTEXT_SEEDS);
}

function capResourceSeedsPerFile(ranked: GraphNode[]): GraphNode[] {
  const resourceCounts = new Map<string, number>();
  return ranked.filter((node) => {
    if (node.kind !== "resource") {
      return true;
    }

    const key = node.filePath ?? node.qualifiedName;
    const count = resourceCounts.get(key) ?? 0;
    if (count >= MAX_RESOURCE_SEEDS_PER_FILE) {
      return false;
    }
    resourceCounts.set(key, count + 1);
    return true;
  });
}

function isExactCodeSeed(node: GraphNode, exactTerms: Set<string>): boolean {
  return node.kind !== "resource" &&
    (exactTerms.has(node.name) ||
      exactTerms.has(node.qualifiedName) ||
      (node.filePath ? exactTerms.has(node.filePath) : false) ||
      exactTerms.has(node.id));
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

function contextSeedScore(
  node: GraphNode,
  query: string,
  exactTerms: Set<string>,
  strategy: ContextStrategy,
  snapshot: ReturnType<typeof loadGraphSnapshot> | null,
): number {
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

  for (const fragment of queryPathFragments(query)) {
    if (nodeFilePathForMatching(node).includes(fragment)) {
      score += node.kind === "resource" ? 360 : 180;
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

  return score + kindPriority(node.kind) + strategySeedScore(node, query, exactTerms, strategy, snapshot);
}

function strategySeedScore(
  node: GraphNode,
  query: string,
  exactTerms: Set<string>,
  strategy: ContextStrategy,
  snapshot: ReturnType<typeof loadGraphSnapshot> | null,
): number {
  if (strategy === "resource-first") {
    return resourceFirstSeedScore(node, query, exactTerms);
  }

  if (strategy === "symbol-first") {
    return symbolFirstSeedScore(node, exactTerms);
  }

  if (strategy === "relationship") {
    return relationshipSeedScore(node, exactTerms, snapshot);
  }

  if (strategy === "source-oriented") {
    return sourceOrientedSeedScore(node, query);
  }

  return 0;
}

function resourceFirstSeedScore(node: GraphNode, query: string, exactTerms: Set<string>): number {
  let score = 0;
  const address = addressForNode(node);
  if (node.kind === "resource") {
    score += 320;
  }
  if (isResourceAddressKind(address.kind)) {
    score += 180;
  }
  if (isResourceLikePath(address.displayPath) || isResourceLikePath(address.referencePath)) {
    score += 120;
  }

  for (const fragment of queryPathFragments(query)) {
    if (nodePathTextForMatching(node).includes(fragment)) {
      score += 180;
    }
  }

  const queryTerms = weightedQueryTerms(query);
  const nodeTerms = nodeContextTerms(node);
  let matchedTerms = 0;
  for (const term of queryTerms.keys()) {
    if (nodeTerms.has(term)) {
      matchedTerms += 1;
    }
  }
  score += matchedTerms * 36;

  if (node.kind !== "resource") {
    score -= exactTermMatchesNode(node, exactTerms) ? 40 : 120;
  }
  if (isLikelyUiSurface(node) || isTestPath(node.filePath)) {
    score -= exactTermMatchesNode(node, exactTerms) ? 60 : 180;
  }
  return score;
}

function symbolFirstSeedScore(node: GraphNode, exactTerms: Set<string>): number {
  let score = exactTermMatchesNode(node, exactTerms) ? 260 : 0;
  if (isSymbolNodeKind(node.kind)) {
    score += 180;
  }
  if (node.kind === "resource") {
    score -= 180;
  }
  if (isLikelyUiSurface(node) && !exactTermMatchesNode(node, exactTerms)) {
    score -= 40;
  }
  return score;
}

function relationshipSeedScore(
  node: GraphNode,
  exactTerms: Set<string>,
  snapshot: ReturnType<typeof loadGraphSnapshot> | null,
): number {
  const relationshipCount = snapshot ? relationshipEvidenceCount(snapshot, node) : 0;
  let score = exactTermMatchesNode(node, exactTerms) ? 320 : -80;
  score += Math.min(relationshipCount * 90, 360);
  if (relationshipCount > 0 && isSymbolNodeKind(node.kind)) {
    score += 100;
  }
  if (relationshipCount === 0 && !exactTermMatchesNode(node, exactTerms)) {
    score -= 140;
  }
  if (node.kind === "resource") {
    score -= 80;
  }
  return score;
}

function sourceOrientedSeedScore(node: GraphNode, query: string): number {
  const loweredQuery = query.toLowerCase();
  const address = addressForNode(node);
  const readablePath = address.readablePath?.toLowerCase() ?? "";
  const displayPath = address.displayPath?.toLowerCase() ?? "";
  let score = 0;
  if (readablePath && loweredQuery.includes(readablePath)) {
    score += 360;
  }
  if (displayPath && loweredQuery.includes(displayPath)) {
    score += 240;
  }
  if (!address.readablePath) {
    score -= 80;
  }
  return score;
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
      ...identifierTerms(metadataSearchText(node.metadata)),
    ]
      .map(normalizeContextTerm)
      .filter((term): term is string => term !== null),
  );
}

function queryPathFragments(query: string): string[] {
  return uniqueStrings(
    (query.match(/[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)+/g) ?? [])
      .map(normalizePathFragment)
      .filter((fragment) => fragment.length > 0),
  );
}

function nodeFilePathForMatching(node: GraphNode): string {
  return nodePathTextForMatching(node);
}

function nodePathTextForMatching(node: GraphNode): string {
  const address = addressForNode(node);
  return normalizePathFragment(
    [
      address.readablePath,
      address.displayPath,
      address.referencePath,
      address.ownerPath,
      node.filePath,
    ]
      .filter((path): path is string => Boolean(path))
      .join(" "),
  );
}

function normalizePathFragment(value: string): string {
  return value
    .toLowerCase()
    .replace(/^res:\/\//, "")
    .replace(/^\/+/, "")
    .replace(/\/+$/, "");
}

function metadataSearchText(value: unknown): string {
  const parts: string[] = [];
  collectMetadataSearchText(value, parts);
  return parts.join(" ");
}

function collectMetadataSearchText(value: unknown, parts: string[]): void {
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    parts.push(String(value));
    return;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      collectMetadataSearchText(item, parts);
    }
    return;
  }

  if (typeof value !== "object" || value === null) {
    return;
  }

  for (const [key, item] of Object.entries(value)) {
    parts.push(key);
    collectMetadataSearchText(item, parts);
  }
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

function isResourceAddressKind(kind: GraphNode["addressKind"]): boolean {
  return kind.startsWith("resource_");
}

function isResourceLikePath(path: string | null): boolean {
  return path ? /\.(?:tres|res|tscn)$/i.test(path) : false;
}

function exactTermMatchesNode(node: GraphNode, exactTerms: Set<string>): boolean {
  return exactTerms.has(node.name) ||
    exactTerms.has(node.qualifiedName) ||
    (node.filePath ? exactTerms.has(node.filePath) : false);
}

function isTestPath(path: string | null): boolean {
  return path ? /(^|\/)tests?\//i.test(path) : false;
}

function isSymbolNodeKind(kind: GraphNode["kind"]): boolean {
  return kind === "script_class" ||
    kind === "inner_class" ||
    kind === "method" ||
    kind === "property" ||
    kind === "signal";
}

function relationshipEvidenceCount(
  snapshot: ReturnType<typeof loadGraphSnapshot>,
  node: GraphNode,
): number {
  return incomingEdges(snapshot, node.id).length +
    outgoingEdges(snapshot, node.id).length +
    refsFrom(snapshot, node.id).length +
    reverseUnresolvedRefsForSeed(snapshot, node).length;
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
