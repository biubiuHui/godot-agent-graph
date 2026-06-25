import type { ContextCandidatePools } from "./candidate-pools.js";
import type { ContextQueryPlan, ContextStrategy } from "./query-plan.js";
import type { GraphSnapshot } from "../graph/traversal.js";
import type { GraphNode } from "../types.js";

export interface RankedSeedSelection {
  strategy: ContextStrategy;
  seeds: GraphNode[];
  resourceAnchorFiles: string[];
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
  const resourceAnchorFiles = resourceAnchorFilesFor(plan, pools);

  switch (plan.strategy) {
    case "resource-first":
      return { strategy: plan.strategy, seeds: selectResourceSeeds(plan, pools), resourceAnchorFiles };
    case "symbol-first":
      return { strategy: plan.strategy, seeds: selectSymbolSeeds(plan, pools), resourceAnchorFiles };
    case "relationship":
      return {
        strategy: plan.strategy,
        seeds: selectRelationshipSeeds(plan, pools, snapshot),
        resourceAnchorFiles,
      };
    case "source-oriented":
      return { strategy: plan.strategy, seeds: selectSourceSeeds(plan, pools), resourceAnchorFiles };
    case "general":
      return { strategy: plan.strategy, seeds: selectGeneralSeeds(plan, pools), resourceAnchorFiles };
  }
}

function selectResourceSeeds(plan: ContextQueryPlan, pools: ContextCandidatePools): GraphNode[] {
  if (plan.resourcePathAnchors.length > 0 && pools.exactPath.length > 0) {
    return limitSeeds(limitResourceSeedsPerFile(pools.exactPath));
  }

  if (pools.exactResourceName.length > 0) {
    const anchoredResources = resourceCandidatesForAnchorFiles(pools.exactResourceName, [
      ...pools.exactResourceName,
      ...pools.resourceMetadata,
      ...pools.resourcePath,
    ]);
    return limitSeeds(limitResourceSeedsPerFile(uniqueNodes([
      ...anchoredResources,
      ...pools.symbolExact,
      ...sortFallbackSymbols(pools.symbolText),
      ...sortFallbackSymbols(usableFallback(plan, pools)),
    ])));
  }

  return limitSeeds(limitResourceSeedsPerFile(uniqueNodes([
    ...pools.exactPath,
    ...pools.exactResourceName,
    ...pools.resourceMetadata,
    ...pools.resourcePath,
    ...pools.symbolExact,
    ...sortFallbackSymbols(pools.symbolText),
    ...sortFallbackSymbols(usableFallback(plan, pools)),
  ])));
}

function selectSymbolSeeds(plan: ContextQueryPlan, pools: ContextCandidatePools): GraphNode[] {
  if (pools.symbolExact.length > 0) {
    return limitSeeds(uniqueNodes([
      ...pools.symbolExact,
      ...pools.resourceMetadata,
    ]));
  }

  return limitSeeds(uniqueNodes([
    ...pools.symbolText.filter((node) => node.kind !== "resource"),
    ...pools.resourceMetadata,
    ...usableFallback(plan, pools),
  ]));
}

function selectRelationshipSeeds(
  plan: ContextQueryPlan,
  pools: ContextCandidatePools,
  snapshot: GraphSnapshot | null,
): GraphNode[] {
  return limitSeeds(
    [...uniqueNodes([...pools.relationship, ...pools.symbolExact, ...pools.symbolText, ...usableFallback(plan, pools)])]
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
      ...usableFallback(plan, pools),
      ...pools.exactPath,
      ...pools.exactResourceName,
      ...pools.resourcePath,
      ...pools.resourceMetadata,
    ]).sort((left, right) =>
      sourcePathPriority(plan, left) - sourcePathPriority(plan, right) ||
      left.id.localeCompare(right.id)
    ),
  );
}

function selectGeneralSeeds(plan: ContextQueryPlan, pools: ContextCandidatePools): GraphNode[] {
  return limitSeeds(uniqueNodes([
    ...pools.symbolExact,
    ...pools.resourcePath,
    ...pools.resourceMetadata,
    ...pools.symbolText,
    ...usableFallback(plan, pools),
  ]));
}

function usableFallback(plan: ContextQueryPlan, pools: ContextCandidatePools): GraphNode[] {
  return plan.allowFallbackText ? pools.fallbackText : [];
}

function resourceCandidatesForAnchorFiles(anchorNodes: GraphNode[], candidates: GraphNode[]): GraphNode[] {
  const anchorFiles = new Set(anchorNodes.map((node) => node.filePath).filter((path): path is string => Boolean(path)));
  return candidates.filter((node) =>
    node.kind === "resource" &&
    node.filePath !== null &&
    anchorFiles.has(node.filePath)
  );
}

function resourceAnchorFilesFor(plan: ContextQueryPlan, pools: ContextCandidatePools): string[] {
  if (plan.strategy !== "resource-first" || pools.exactResourceName.length === 0) {
    return [];
  }
  return uniqueStrings(
    pools.exactResourceName
      .map((node) => node.filePath)
      .filter((path): path is string => Boolean(path)),
  );
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

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.filter((value) => value.length > 0))];
}

function isLikelyUiOrTopic(node: GraphNode): boolean {
  return /\b(panel|topic|ui|text)\b/i.test([node.name, node.qualifiedName, node.filePath ?? ""].join(" "));
}

function isTestPath(path: string | null): boolean {
  return path ? /(^|\/)tests?\//i.test(path) : false;
}
