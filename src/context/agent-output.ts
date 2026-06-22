import type { AgentNodeSummary } from "./explore.js";
import type { AgentBlastRadius } from "./explore.js";
import type { SourceSnippet } from "./formatter.js";

export interface AgentContextInput {
  query: string;
  entryPoints?: string[];
  pathsBetween?: string[];
  blastRadius?: AgentBlastRadius;
  nodes: AgentNodeSummary[];
  relationships: string[];
  files: string[];
  snippets: SourceSnippet[];
}

export interface AgentOutputOptions {
  maxNodes?: number;
  maxRelationships?: number;
  maxSnippets?: number;
  maxChars?: number;
}

export interface AgentFormattedContext {
  query: string;
  prefixes?: Record<string, string>;
  paths: Record<string, string>;
  entryPoints: string[];
  pathsBetween: AgentFormattedRelationship[];
  blastRadius?: AgentFormattedBlastRadius;
  nodes: AgentFormattedNode[];
  relationships: AgentFormattedRelationship[];
  snippets: AgentFormattedSnippet[];
  truncated: boolean;
  omitted: {
    nodes: number;
    relationships: number;
    snippets: number;
  };
  budget: {
    maxChars: number;
    estimatedChars: number;
  };
}

export interface AgentFormattedNode {
  id: string;
  graphId: string;
  kind: string;
  name: string;
  qname?: string;
  path?: string;
  line?: number;
  signature?: string;
}

export interface AgentFormattedRelationship {
  from?: string;
  graphFrom?: string;
  kind: string;
  to?: string;
  graphTo?: string;
  target?: string;
  provenance: string;
}

export interface AgentFormattedSnippet {
  path: string;
  start: number;
  end: number;
  text: string;
}

export interface AgentFormattedBlastRadius {
  entryPoints: string[];
  checkFiles: string[];
  relationshipCount: number;
}

export interface AgentPathRefs {
  paths: Record<string, string>;
  pathToRef: Record<string, string>;
  prefixes: Record<string, string>;
}

const DEFAULT_MAX_NODES = 40;
const DEFAULT_MAX_RELATIONSHIPS = 40;
const DEFAULT_MAX_SNIPPETS = 6;
const DEFAULT_MAX_CHARS = 8_000;
const MIN_PREFIX_LENGTH = "res://a/b/".length;
const MIN_RELATIONSHIPS_WHEN_TRUNCATED = 3;

export function formatAgentContext(
  context: AgentContextInput,
  options: AgentOutputOptions = {},
): AgentFormattedContext {
  const limits = {
    maxNodes: options.maxNodes ?? DEFAULT_MAX_NODES,
    maxRelationships: options.maxRelationships ?? DEFAULT_MAX_RELATIONSHIPS,
    maxSnippets: options.maxSnippets ?? DEFAULT_MAX_SNIPPETS,
    maxChars: options.maxChars ?? DEFAULT_MAX_CHARS,
  };

  const pathTable = createPathTable(context);
  const visibleNodes = context.nodes.slice(0, limits.maxNodes);
  const nodeIntern = createNodeIntern(visibleNodes);
  const allNodes = visibleNodes.map((node) => formatNode(node, pathTable, nodeIntern));
  const allRelationships = context.relationships.map((relationship) =>
    formatRelationship(relationship, nodeIntern),
  );
  const allSnippets = context.snippets
    .filter((snippet) => snippet.filePath in pathTable.pathToRef)
    .map((snippet) => ({
      path: pathTable.pathToRef[snippet.filePath],
      start: snippet.startLine,
      end: snippet.endLine,
      text: snippet.text,
    }));

  const output: AgentFormattedContext = {
    query: context.query,
    ...(Object.keys(pathTable.prefixes).length > 0 ? { prefixes: pathTable.prefixes } : {}),
    paths: pathTable.paths,
    entryPoints: (context.entryPoints ?? [])
      .map((id) => nodeIntern.idToRef[id])
      .filter((id): id is string => Boolean(id)),
    pathsBetween: (context.pathsBetween ?? []).map((relationship) =>
      formatRelationship(relationship, nodeIntern),
    ),
    ...(context.blastRadius
      ? { blastRadius: formatBlastRadius(context.blastRadius, pathTable, nodeIntern) }
      : {}),
    nodes: allNodes,
    relationships: allRelationships.slice(0, limits.maxRelationships),
    snippets: allSnippets.slice(0, limits.maxSnippets),
    truncated: false,
    omitted: {
      nodes: Math.max(0, context.nodes.length - limits.maxNodes),
      relationships: Math.max(0, allRelationships.length - limits.maxRelationships),
      snippets: Math.max(0, allSnippets.length - limits.maxSnippets),
    },
    budget: {
      maxChars: limits.maxChars,
      estimatedChars: 0,
    },
  };

  applyCharacterBudget(output, limits.maxChars);
  return output;
}

function formatBlastRadius(
  blastRadius: AgentBlastRadius,
  pathTable: { pathToRef: Record<string, string> },
  nodeIntern: { idToRef: Record<string, string> },
): AgentFormattedBlastRadius {
  return {
    entryPoints: blastRadius.entryPoints
      .map((id) => nodeIntern.idToRef[id])
      .filter((id): id is string => Boolean(id)),
    checkFiles: blastRadius.checkFiles
      .map((path) => pathTable.pathToRef[path])
      .filter((id): id is string => Boolean(id)),
    relationshipCount: blastRadius.relationshipCount,
  };
}

function createPathTable(context: AgentContextInput): AgentPathRefs {
  const rawPaths = uniqueStrings([
    ...context.files,
    ...context.nodes.flatMap((node) => (node.filePath ? [node.filePath] : [])),
    ...context.snippets.map((snippet) => snippet.filePath),
  ]);
  return createAgentPathRefs(rawPaths);
}

export function createAgentPathRefs(rawPaths: string[]): AgentPathRefs {
  const pathsToIntern = uniqueStrings(rawPaths);
  const commonPrefix = commonDirectoryPrefix(pathsToIntern);
  const prefixes: Record<string, string> = {};
  if (commonPrefix && commonPrefix.length >= MIN_PREFIX_LENGTH) {
    prefixes["@p1"] = commonPrefix;
  }
  const paths: Record<string, string> = {};
  const pathToRef: Record<string, string> = {};

  pathsToIntern.forEach((path, index) => {
    const ref = `p${index + 1}`;
    pathToRef[path] = ref;
    paths[ref] = prefixes["@p1"] ? path.replace(prefixes["@p1"], "@p1/") : path;
  });

  return { paths, pathToRef, prefixes };
}

function createNodeIntern(nodes: AgentNodeSummary[]): {
  idToRef: Record<string, string>;
} {
  const idToRef: Record<string, string> = {};
  nodes.forEach((node, index) => {
    idToRef[node.id] = `n${index + 1}`;
  });
  return { idToRef };
}

function formatNode(
  node: AgentNodeSummary,
  pathTable: { pathToRef: Record<string, string> },
  nodeIntern: { idToRef: Record<string, string> },
): AgentFormattedNode {
  return removeUndefined({
    id: nodeIntern.idToRef[node.id],
    graphId: node.id,
    kind: node.kind,
    name: node.name,
    qname: node.qualifiedName && node.qualifiedName !== node.name ? node.qualifiedName : undefined,
    path: node.filePath ? pathTable.pathToRef[node.filePath] : undefined,
    line: node.startLine ?? undefined,
    signature: node.signature ?? undefined,
  });
}

function formatRelationship(
  relationship: string,
  nodeIntern: { idToRef: Record<string, string> },
): AgentFormattedRelationship {
  const parsed = parseRelationship(relationship);
  if (!parsed) {
    return {
      kind: "related",
      target: relationship,
      provenance: "text",
    };
  }

  const fromRef = nodeIntern.idToRef[parsed.source];
  const toRef = nodeIntern.idToRef[parsed.target];
  return removeUndefined({
    from: fromRef,
    graphFrom: fromRef ? undefined : parsed.source,
    kind: parsed.kind,
    to: toRef,
    graphTo: toRef || parsed.provenance === "unresolved" ? undefined : parsed.target,
    target: toRef || parsed.provenance !== "unresolved" ? undefined : parsed.target,
    provenance: parsed.provenance,
  });
}

function parseRelationship(
  relationship: string,
): { source: string; kind: string; target: string; provenance: string } | null {
  const match = relationship.match(/^(\S+) ([a-z_]+) (.+) \(([^)]+)\)$/);
  if (!match) {
    return null;
  }

  return {
    source: match[1],
    kind: match[2],
    target: match[3],
    provenance: match[4],
  };
}

function applyCharacterBudget(output: AgentFormattedContext, maxChars: number): void {
  output.budget.estimatedChars = estimatedChars(output);
  while (output.budget.estimatedChars > maxChars) {
    if (output.snippets.length > 0) {
      output.snippets.pop();
      output.omitted.snippets += 1;
    } else if (output.relationships.length > MIN_RELATIONSHIPS_WHEN_TRUNCATED) {
      output.relationships.pop();
      output.omitted.relationships += 1;
    } else if (removeUnreferencedTailNode(output)) {
      output.omitted.nodes += 1;
    } else if (output.relationships.length > 0) {
      output.relationships.pop();
      output.omitted.relationships += 1;
    } else if (output.nodes.length > 0) {
      output.nodes.pop();
      output.omitted.nodes += 1;
    } else {
      break;
    }
    output.truncated = true;
    output.budget.estimatedChars = estimatedChars(output);
  }
  output.truncated =
    output.truncated ||
    output.omitted.nodes > 0 ||
    output.omitted.relationships > 0 ||
    output.omitted.snippets > 0;
}

function removeUnreferencedTailNode(output: AgentFormattedContext): boolean {
  const protectedNodeRefs = new Set<string>([
    ...output.entryPoints,
    ...relationshipNodeRefs(output.relationships),
    ...relationshipNodeRefs(output.pathsBetween),
    ...(output.blastRadius?.entryPoints ?? []),
  ]);

  for (let index = output.nodes.length - 1; index >= 0; index -= 1) {
    const node = output.nodes[index];
    if (!node || protectedNodeRefs.has(node.id)) {
      continue;
    }

    output.nodes.splice(index, 1);
    return true;
  }

  return false;
}

function relationshipNodeRefs(relationships: AgentFormattedRelationship[]): string[] {
  return relationships.flatMap((relationship) => [
    ...(relationship.from ? [relationship.from] : []),
    ...(relationship.to ? [relationship.to] : []),
  ]);
}

function estimatedChars(value: unknown): number {
  return JSON.stringify(value).length;
}

function commonDirectoryPrefix(paths: string[]): string | null {
  if (paths.length < 2) {
    return null;
  }

  const directories = paths.map((path) => path.slice(0, path.lastIndexOf("/") + 1));
  let prefix = directories[0] ?? "";
  for (const directory of directories.slice(1)) {
    while (prefix && !directory.startsWith(prefix)) {
      prefix = prefix.slice(0, prefix.slice(0, -1).lastIndexOf("/") + 1);
    }
  }

  return prefix.length > 0 ? prefix : null;
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.filter((value) => value.length > 0))];
}

function removeUndefined<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(
    Object.entries(value).filter(([, entryValue]) => entryValue !== undefined),
  ) as T;
}
