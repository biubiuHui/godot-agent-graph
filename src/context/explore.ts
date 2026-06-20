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
  nodes: AgentNodeSummary[];
  relationships: string[];
  files: string[];
  snippets: SourceSnippet[];
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
  const seeds = searchNodes(graph, options.query, 10);
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

  return finalizeContext(options.projectRoot, options.symbol, related, relationships, options);
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

  return finalizeContext(options.projectRoot, options.symbol, related, relationships, options);
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

  return finalizeContext(projectRoot, query, related, relationships, options);
}

function finalizeContext(
  projectRoot: string,
  query: string,
  nodes: GraphNode[],
  relationships: string[],
  options: ContextQueryOptions,
): AgentContext {
  const unique = uniqueNodes(nodes).slice(0, MAX_CONTEXT_NODES);
  const files = collectFilePaths(unique, options.maxFiles ?? 6);
  return {
    query,
    nodes: unique.map(summarizeAgentNode),
    relationships: prioritizeRelationships(uniqueStrings(relationships)).slice(0, MAX_CONTEXT_RELATIONSHIPS),
    files,
    snippets: sourceSnippetsForFiles(projectRoot, files, {
      includeCode: options.includeCode ?? true,
      maxLinesPerFile: 20,
    }),
  };
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
