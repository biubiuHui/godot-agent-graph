import type { ContextCandidatePools } from "./candidate-pools.js";
import type { ContextQueryPlan, ContextStrategy } from "./query-plan.js";
import type { GraphSnapshot } from "../graph/traversal.js";
import type { GraphNode } from "../types.js";

export interface RankedSeedSelection {
  strategy: ContextStrategy;
  seeds: GraphNode[];
}

const MAX_CONTEXT_SEEDS = 12;
const MAX_RESOURCE_SEEDS_PER_FILE = 2;
const ORDINARY_SYMBOL_PRIORITY = 0;
const UI_OR_TOPIC_SYMBOL_PRIORITY = 20;
const TEST_SYMBOL_PRIORITY = 30;
const EXACT_SOURCE_PATH_PRIORITY = 0;
const EXACT_NON_SOURCE_PATH_PRIORITY = 10;
const NON_RESOURCE_SOURCE_PRIORITY = 20;
const RESOURCE_SOURCE_PRIORITY = 30;

export function selectRankedSeeds(
  plan: ContextQueryPlan,
  pools: ContextCandidatePools,
  snapshot: GraphSnapshot | null,
): RankedSeedSelection {
  switch (plan.strategy) {
    case "resource-first":
      return { strategy: plan.strategy, seeds: selectResourceSeeds(plan, pools) };
    case "symbol-first":
      return { strategy: plan.strategy, seeds: selectSymbolSeeds(pools) };
    case "relationship":
      return { strategy: plan.strategy, seeds: selectRelationshipSeeds(pools, snapshot) };
    case "source-oriented":
      return { strategy: plan.strategy, seeds: selectSourceSeeds(plan, pools) };
    case "general":
      return { strategy: plan.strategy, seeds: selectGeneralSeeds(pools) };
  }
}

function selectResourceSeeds(plan: ContextQueryPlan, pools: ContextCandidatePools): GraphNode[] {
  if (plan.resourcePathAnchors.length > 0 && pools.exactPath.length > 0) {
    return limitSeeds(limitResourceSeedsPerFile(pools.exactPath));
  }

  return limitSeeds(limitResourceSeedsPerFile(uniqueNodes([
    ...pools.exactPath,
    ...pools.resourcePath,
    ...pools.resourceMetadata,
    ...pools.symbolExact,
    ...sortFallbackSymbols(pools.symbolText),
    ...sortFallbackSymbols(pools.fallbackText),
  ])));
}

function selectSymbolSeeds(pools: ContextCandidatePools): GraphNode[] {
  if (pools.symbolExact.length > 0) {
    return limitSeeds(uniqueNodes([
      ...pools.symbolExact,
      ...pools.resourceMetadata,
    ]));
  }

  return limitSeeds(uniqueNodes([
    ...pools.symbolText.filter((node) => node.kind !== "resource"),
    ...pools.resourceMetadata,
    ...pools.fallbackText,
  ]));
}

function selectRelationshipSeeds(
  pools: ContextCandidatePools,
  snapshot: GraphSnapshot | null,
): GraphNode[] {
  return limitSeeds(
    [...uniqueNodes([...pools.relationship, ...pools.symbolExact, ...pools.symbolText, ...pools.fallbackText])]
      .sort((left, right) =>
        relationshipEvidenceCount(snapshot, right) - relationshipEvidenceCount(snapshot, left) ||
        left.id.localeCompare(right.id)
      ),
  );
}

function selectSourceSeeds(plan: ContextQueryPlan, pools: ContextCandidatePools): GraphNode[] {
  return limitSeeds(
    uniqueNodes([
      ...pools.symbolExact,
      ...pools.symbolText,
      ...pools.fallbackText,
      ...pools.exactPath,
      ...pools.resourcePath,
      ...pools.resourceMetadata,
    ]).sort((left, right) =>
      sourcePathPriority(plan, left) - sourcePathPriority(plan, right) ||
      left.id.localeCompare(right.id)
    ),
  );
}

function selectGeneralSeeds(pools: ContextCandidatePools): GraphNode[] {
  return limitSeeds(uniqueNodes([
    ...pools.symbolExact,
    ...pools.resourcePath,
    ...pools.resourceMetadata,
    ...pools.symbolText,
    ...pools.fallbackText,
  ]));
}

function sortFallbackSymbols(nodes: GraphNode[]): GraphNode[] {
  return [...nodes].sort((left, right) =>
    fallbackSymbolPriority(left) - fallbackSymbolPriority(right) ||
    left.id.localeCompare(right.id)
  );
}

function fallbackSymbolPriority(node: GraphNode): number {
  if (isTestPath(node.filePath)) {
    return TEST_SYMBOL_PRIORITY;
  }
  if (isLikelyUiOrTopic(node)) {
    return UI_OR_TOPIC_SYMBOL_PRIORITY;
  }
  return ORDINARY_SYMBOL_PRIORITY;
}

function sourcePathPriority(plan: ContextQueryPlan, node: GraphNode): number {
  const loweredQuery = plan.rawQuery.toLowerCase();
  const paths = [node.readablePath, node.filePath, node.displayPath, node.ownerPath]
    .filter((path): path is string => Boolean(path))
    .map((path) => path.toLowerCase());
  if (paths.some((path) => path.endsWith(".gd") && loweredQuery.includes(path))) {
    return EXACT_SOURCE_PATH_PRIORITY;
  }
  if (paths.some((path) => loweredQuery.includes(path))) {
    return EXACT_NON_SOURCE_PATH_PRIORITY;
  }
  if (node.kind === "resource") {
    return RESOURCE_SOURCE_PRIORITY;
  }
  return NON_RESOURCE_SOURCE_PRIORITY;
}

function relationshipEvidenceCount(snapshot: GraphSnapshot | null, node: GraphNode): number {
  if (!snapshot) {
    return 0;
  }

  return snapshot.edges.filter((edge) => edge.source === node.id || edge.target === node.id).length +
    snapshot.unresolvedRefs.filter((ref) => ref.fromNodeId === node.id).length;
}

function limitResourceSeedsPerFile(nodes: GraphNode[]): GraphNode[] {
  const resourceCounts = new Map<string, number>();
  return nodes.filter((node) => {
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

function limitSeeds(nodes: GraphNode[]): GraphNode[] {
  return nodes.slice(0, MAX_CONTEXT_SEEDS);
}

function uniqueNodes(nodes: GraphNode[]): GraphNode[] {
  const seen = new Set<string>();
  return nodes.filter((node) => {
    if (seen.has(node.id)) {
      return false;
    }
    seen.add(node.id);
    return true;
  });
}

function isLikelyUiOrTopic(node: GraphNode): boolean {
  return /\b(panel|topic|ui|text)\b/i.test([node.name, node.qualifiedName, node.filePath ?? ""].join(" "));
}

function isTestPath(path: string | null): boolean {
  return path ? /(^|\/)tests?\//i.test(path) : false;
}
