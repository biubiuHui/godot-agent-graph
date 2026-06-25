import type { GraphDatabase } from "../db/index.js";
import { searchNodes } from "../db/queries.js";
import type { GraphNode } from "../types.js";
import type { ContextQueryPlan } from "./query-plan.js";

export interface ContextCandidatePools {
  exactPath: GraphNode[];
  exactResourceName: GraphNode[];
  resourcePath: GraphNode[];
  resourceMetadata: GraphNode[];
  symbolExact: GraphNode[];
  symbolText: GraphNode[];
  relationship: GraphNode[];
  fallbackText: GraphNode[];
}

const EXACT_PATH_LIMIT = 80;
const EXACT_RESOURCE_NAME_LIMIT = 40;
const RESOURCE_PATH_LIMIT = 40;
const METADATA_TERM_LIMIT = 12;
const SYMBOL_TERM_LIMIT = 12;
const FALLBACK_TEXT_LIMIT = 20;

export function collectCandidatePools(
  graph: GraphDatabase,
  plan: ContextQueryPlan,
): ContextCandidatePools {
  return {
    exactPath: collectExactPathCandidates(graph, plan),
    exactResourceName: collectExactResourceNameCandidates(graph, plan),
    resourcePath: collectResourcePathCandidates(graph, plan),
    resourceMetadata: collectResourceMetadataCandidates(graph, plan),
    symbolExact: collectSymbolExactCandidates(graph, plan),
    symbolText: collectSymbolTextCandidates(graph, plan),
    relationship: collectRelationshipCandidates(graph, plan),
    fallbackText: collectFallbackTextCandidates(graph, plan),
  };
}

function collectExactPathCandidates(graph: GraphDatabase, plan: ContextQueryPlan): GraphNode[] {
  return uniqueNodes(
    plan.resourcePathAnchors.flatMap((anchor) =>
      searchNodes(graph, anchor, EXACT_PATH_LIMIT)
        .filter((node) => nodeMatchesPathAnchor(node, anchor))
    ),
  );
}

function collectExactResourceNameCandidates(graph: GraphDatabase, plan: ContextQueryPlan): GraphNode[] {
  return uniqueNodes(
    plan.resourceNameAnchors.flatMap((anchor) =>
      searchNodes(graph, anchor, EXACT_RESOURCE_NAME_LIMIT)
        .filter((node) => isResourceNode(node) && nodeMatchesResourceNameAnchor(node, anchor))
    ),
  );
}

function collectResourcePathCandidates(graph: GraphDatabase, plan: ContextQueryPlan): GraphNode[] {
  const directoryMatches = plan.resourceDirectoryAnchors.flatMap((anchor) =>
    searchNodes(graph, anchor, RESOURCE_PATH_LIMIT)
  );
  const exactPathMatches = plan.resourcePathAnchors.flatMap((anchor) =>
    searchNodes(graph, anchor, RESOURCE_PATH_LIMIT)
  );
  return uniqueNodes([...directoryMatches, ...exactPathMatches].filter(isResourceNode));
}

function collectResourceMetadataCandidates(graph: GraphDatabase, plan: ContextQueryPlan): GraphNode[] {
  if (plan.strategy !== "resource-first") {
    return [];
  }

  return uniqueNodes(
    [...plan.fieldTerms, ...plan.symbolTerms, ...textRecallTerms(plan)]
      .flatMap((term) => searchNodes(graph, term, METADATA_TERM_LIMIT))
      .filter(isResourceNode),
  );
}

function collectSymbolExactCandidates(graph: GraphDatabase, plan: ContextQueryPlan): GraphNode[] {
  return uniqueNodes(
    [...plan.symbolTerms, ...plan.fieldTerms]
      .flatMap((term) => searchNodes(graph, term, SYMBOL_TERM_LIMIT)
        .filter((node) => nodeMatchesExactTerm(node, term))),
  );
}

function collectSymbolTextCandidates(graph: GraphDatabase, plan: ContextQueryPlan): GraphNode[] {
  return uniqueNodes(
    [...plan.symbolTerms, ...plan.fieldTerms, ...textRecallTerms(plan)]
      .flatMap((term) => searchNodes(graph, term, SYMBOL_TERM_LIMIT))
      .filter((node) => !isResourceNode(node)),
  );
}

function collectRelationshipCandidates(graph: GraphDatabase, plan: ContextQueryPlan): GraphNode[] {
  if (plan.strategy !== "relationship") {
    return [];
  }

  return uniqueNodes(
    [...plan.symbolTerms, ...plan.fieldTerms, ...textRecallTerms(plan)]
      .flatMap((term) => searchNodes(graph, term, SYMBOL_TERM_LIMIT)),
  );
}

function collectFallbackTextCandidates(graph: GraphDatabase, plan: ContextQueryPlan): GraphNode[] {
  if (!plan.allowFallbackText) {
    return [];
  }

  return uniqueNodes([
    ...searchNodes(graph, plan.rawQuery, FALLBACK_TEXT_LIMIT),
    ...plan.textTerms.flatMap((term) => searchNodes(graph, term, FALLBACK_TEXT_LIMIT)),
  ]);
}

function nodeMatchesPathAnchor(node: GraphNode, anchor: string): boolean {
  return [
    node.filePath,
    node.ownerPath,
    node.displayPath,
    node.readablePath,
    node.referencePath,
  ].some((path) => path === anchor);
}

function nodeMatchesResourceNameAnchor(node: GraphNode, anchor: string): boolean {
  const stem = pathStem(node.filePath ?? node.name);
  return node.name === anchor ||
    node.name === `${anchor}.tres` ||
    node.qualifiedName.endsWith(`/${anchor}.tres`) ||
    stem === anchor ||
    node.id.includes(`/${anchor}.`);
}

function nodeMatchesExactTerm(node: GraphNode, term: string): boolean {
  return node.name === term ||
    node.qualifiedName === term ||
    node.id === term ||
    node.filePath === term;
}

function isResourceNode(node: GraphNode): boolean {
  return node.kind === "resource";
}

function textRecallTerms(plan: ContextQueryPlan): string[] {
  return plan.allowFallbackText ? plan.textTerms : [];
}

function pathStem(path: string): string {
  const basename = path.split("/").at(-1) ?? path;
  return basename.replace(/\.(?:tres|res|tscn|gd)$/i, "");
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
