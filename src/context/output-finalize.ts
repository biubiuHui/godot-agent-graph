import type {
  AgentBlastRadius,
  AgentContextCompleteness,
  ContextStrategy,
} from "./explore.js";
import {
  relationshipEndpointIds,
  type AgentOutputView,
  type NodeReadOutputView,
  type ViewNode,
  type ViewFileTarget,
  type ViewRelationship,
  type ViewRelationshipNoteGroups,
} from "./output-view.js";

export type AgentOutputInvariantReason =
  | "unresolved_relationship_source"
  | "unresolved_relationship_target"
  | "orphan_context_path"
  | "orphan_node_read_path";

export class AgentOutputInvariantError extends Error {
  constructor(readonly reason: AgentOutputInvariantReason) {
    super("Agent output invariant failed");
    this.name = "AgentOutputInvariantError";
  }
}

export function isAgentOutputInvariantError(error: unknown): error is AgentOutputInvariantError {
  return error instanceof AgentOutputInvariantError;
}

export function agentOutputInvariantReason(error: unknown): AgentOutputInvariantReason | null {
  return isAgentOutputInvariantError(error) ? error.reason : null;
}

export interface AgentFormattedContext {
  query: string;
  strategy?: ContextStrategy;
  completeness?: AgentContextCompleteness;
  prefixes?: Record<string, string>;
  paths: Record<string, string>;
  entryPoints: string[];
  pathsBetween: AgentFormattedRelationship[];
  blastRadius?: AgentFormattedBlastRadius;
  nodes: AgentFormattedNode[];
  selectors?: Record<string, AgentFormattedSelector>;
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
  kind: string;
  name: string;
  qname?: string;
  path?: string;
  line?: number;
  signature?: string;
}

export interface AgentFormattedSelector {
  id?: string;
  kind?: string;
  path?: string;
  suffix?: string;
}

export interface AgentFormattedRelationship {
  from?: string;
  kind: string;
  to?: string;
  target?: string;
  targetPath?: string;
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

export interface AgentFormattedNodeRead {
  ok: true;
  prefixes?: Record<string, string>;
  paths: Record<string, string>;
  target: Record<string, unknown>;
  symbols?: Array<Record<string, unknown>>;
  notes?: Record<string, unknown>;
  source?: Record<string, unknown>;
  stale?: true;
  staleFiles?: string[];
}

const MIN_PREFIX_LENGTH = "res://a/b/".length;

export function finalizeAgentOutput(view: AgentOutputView & { kind: "context" }): AgentFormattedContext;
export function finalizeAgentOutput(view: NodeReadOutputView): AgentFormattedNodeRead;
export function finalizeAgentOutput(view: AgentOutputView): AgentFormattedContext | AgentFormattedNodeRead;
export function finalizeAgentOutput(view: AgentOutputView): AgentFormattedContext | AgentFormattedNodeRead {
  if (view.kind === "node_read") {
    return finalizeNodeReadOutput(view);
  }

  const pathRefs = createAgentPathRefs(visiblePathValues(view));
  const nodeIntern = createNodeIntern([
    ...view.nodes.map((node) => node.graphId),
    ...relationshipEndpointIds(view.relationships),
    ...relationshipEndpointIds(view.pathsBetween),
    ...view.entryPointIds,
    ...(view.blastRadius?.entryPoints ?? []),
  ]);
  const output: AgentFormattedContext = {
    query: view.query ?? "",
    ...(view.strategy ? { strategy: view.strategy } : {}),
    ...(view.completeness ? { completeness: view.completeness } : {}),
    ...(Object.keys(pathRefs.prefixes).length > 0 ? { prefixes: pathRefs.prefixes } : {}),
    paths: pathRefs.paths,
    entryPoints: view.entryPointIds
      .map((id) => nodeIntern.idToRef[id])
      .filter((id): id is string => Boolean(id)),
    pathsBetween: view.pathsBetween.map((relationship) =>
      formatRelationship(relationship, nodeIntern, pathRefs),
    ),
    ...(view.blastRadius
      ? { blastRadius: formatBlastRadius(view.blastRadius, pathRefs, nodeIntern) }
      : {}),
    nodes: view.nodes.map((node) => formatNode(node, pathRefs, nodeIntern)),
    relationships: view.relationships.map((relationship) =>
      formatRelationship(relationship, nodeIntern, pathRefs),
    ),
    snippets: view.snippets
      .filter((snippet) => snippet.filePath in pathRefs.pathToRef)
      .map((snippet) => ({
        path: pathRefs.pathToRef[snippet.filePath],
        start: snippet.startLine,
        end: snippet.endLine,
        text: snippet.text,
      })),
    truncated: view.truncated ||
      view.omitted.nodes > 0 ||
      view.omitted.relationships > 0 ||
      view.omitted.snippets > 0,
    omitted: { ...view.omitted },
    budget: {
      maxChars: view.budget.maxChars,
      estimatedChars: 0,
    },
  };

  const selectors = formatSelectors(view.nodes, [...view.relationships, ...view.pathsBetween], pathRefs, nodeIntern);
  if (Object.keys(selectors).length > 0) {
    output.selectors = selectors;
  }

  pruneEmptyReferences(output);
  output.budget.estimatedChars = stableEstimatedChars(output);
  assertContextOutputInvariants(output);
  return output;
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

export function estimatedChars(value: unknown): number {
  return JSON.stringify(value).length;
}

function visiblePathValues(view: AgentOutputView): string[] {
  if (view.kind === "node_read") {
    return visibleNodeReadPathValues(view);
  }

  return uniqueStrings([
    ...view.nodes.flatMap(pathForNode),
    ...view.snippets.map((snippet) => snippet.filePath),
    ...view.relationships.flatMap(relationshipOutputPathValues),
    ...view.pathsBetween.flatMap(relationshipOutputPathValues),
    ...(view.blastRadius?.checkFiles ?? []),
  ]);
}

function relationshipOutputPathValues(relationship: ViewRelationship): string[] {
  const unresolvedTargetPath = relationship.provenance === "unresolved" && relationship.target.startsWith("res://")
    ? [relationship.target]
    : [];

  return unresolvedTargetPath;
}

function finalizeNodeReadOutput(view: NodeReadOutputView): AgentFormattedNodeRead {
  const pathRefs = createAgentPathRefs(visibleNodeReadPathValues(view));
  const noteNodes = nodeReadNoteNodes(view.nodeRead.notes);
  const graphNodes = uniqueViewNodes([
    ...("graphId" in view.nodeRead.target ? [view.nodeRead.target] : []),
    ...view.nodeRead.symbols,
    ...noteNodes,
  ]);
  const nodeRefs = createNodeRefMap(graphNodes);
  const expandedNodeIds = new Set([
    ...("graphId" in view.nodeRead.target ? [view.nodeRead.target.graphId] : []),
    ...view.nodeRead.symbols.map((node) => node.graphId),
  ]);
  const output = removeUndefined({
    ok: true,
    ...(Object.keys(pathRefs.prefixes).length > 0 ? { prefixes: pathRefs.prefixes } : {}),
    paths: pathRefs.paths,
    target: "graphId" in view.nodeRead.target
      ? formatNodeReadGraphNode(view.nodeRead.target, pathRefs, nodeRefs)
      : formatFileTarget(view.nodeRead.target, pathRefs),
    symbols: view.nodeRead.symbols.length > 0
      ? view.nodeRead.symbols.map((node) => formatNodeReadGraphNode(node, pathRefs, nodeRefs))
      : undefined,
    notes: view.nodeRead.notes
      ? formatNodeReadNotes(view.nodeRead.notes, pathRefs, nodeRefs, expandedNodeIds)
      : undefined,
    source: view.source ? formatSource(view.source, pathRefs) : undefined,
    stale: view.nodeRead.staleFilePaths.length > 0 ? true : undefined,
    staleFiles: view.nodeRead.staleFilePaths.length > 0
      ? view.nodeRead.staleFilePaths
          .map((filePath) => pathRefs.pathToRef[filePath])
          .filter((path): path is string => Boolean(path))
      : undefined,
  }) as AgentFormattedNodeRead;

  pruneNodeReadPrefixes(output);
  assertNodeReadOutputInvariants(output);
  return output;
}

function visibleNodeReadPathValues(view: NodeReadOutputView): string[] {
  return uniqueStrings([
    ...("graphId" in view.nodeRead.target ? pathForNode(view.nodeRead.target) : [view.nodeRead.target.filePath]),
    ...view.nodeRead.symbols.flatMap(pathForNode),
    ...nodeReadNoteNodes(view.nodeRead.notes).flatMap(pathForNode),
    ...(view.source?.filePath ? [view.source.filePath] : []),
    ...view.nodeRead.staleFilePaths,
  ]);
}

function pathForNode(node: ViewNode): string[] {
  const path = viewNodeDisplayPath(node);
  return path ? [path] : [];
}

function viewNodeDisplayPath(node: ViewNode): string | null {
  return node.displayPath ?? node.filePath;
}

function nodeReadNoteNodes(notes: ViewRelationshipNoteGroups | undefined): ViewNode[] {
  if (!notes) {
    return [];
  }
  return [
    ...notes.callers,
    ...notes.callees,
    ...notes.dependents,
    ...notes.dependencies,
  ];
}

function createNodeIntern(nodeIds: string[]): {
  idToRef: Record<string, string>;
} {
  const idToRef: Record<string, string> = {};
  uniqueStrings(nodeIds).forEach((id, index) => {
    idToRef[id] = `n${index + 1}`;
  });
  return { idToRef };
}

function createNodeRefMap(nodes: ViewNode[]): Map<string, string> {
  return new Map(uniqueViewNodes(nodes).map((node, index) => [node.graphId, `n${index + 1}`]));
}

function uniqueViewNodes(nodes: ViewNode[]): ViewNode[] {
  const seen = new Set<string>();
  return nodes.filter((node) => {
    if (seen.has(node.graphId)) {
      return false;
    }
    seen.add(node.graphId);
    return true;
  });
}

function formatNode(
  node: ViewNode,
  pathRefs: { pathToRef: Record<string, string> },
  nodeIntern: { idToRef: Record<string, string> },
): AgentFormattedNode {
  return removeUndefined({
    id: nodeIntern.idToRef[node.graphId],
    kind: node.kind,
    name: node.name,
    qname: displayQualifiedName(node),
    path: pathRefForNode(node, pathRefs),
    line: node.startLine ?? undefined,
    signature: node.signature ?? undefined,
  });
}

function formatFileTarget(target: ViewFileTarget, pathRefs: AgentPathRefs): Record<string, unknown> {
  return {
    kind: "file",
    path: pathRefs.pathToRef[target.filePath],
    fileKind: target.fileKind,
    nodeCount: target.nodeCount,
  };
}

function formatNodeReadGraphNode(
  node: ViewNode,
  pathRefs: AgentPathRefs,
  nodeRefs: Map<string, string>,
): Record<string, unknown> {
  return removeUndefined({
    id: nodeRefs.get(node.graphId),
    kind: node.kind,
    name: node.name,
    qname: displayQualifiedName(node),
    path: pathRefForNode(node, pathRefs),
    line: node.startLine ?? undefined,
    signature: node.signature ?? undefined,
  });
}

function formatNodeReadNotes(
  notes: ViewRelationshipNoteGroups,
  pathRefs: AgentPathRefs,
  nodeRefs: Map<string, string>,
  expandedNodeIds: Set<string>,
): Record<string, unknown> {
  return {
    complete: notes.complete,
    callers: notes.callers.map((node) => formatNoteNode(node, pathRefs, nodeRefs, expandedNodeIds)),
    callees: notes.callees.map((node) => formatNoteNode(node, pathRefs, nodeRefs, expandedNodeIds)),
    dependents: notes.dependents.map((node) => formatNoteNode(node, pathRefs, nodeRefs, expandedNodeIds)),
    dependencies: notes.dependencies.map((node) => formatNoteNode(node, pathRefs, nodeRefs, expandedNodeIds)),
    limit: notes.limit,
    omitted: notes.omitted,
  };
}

function formatNoteNode(
  node: ViewNode,
  pathRefs: AgentPathRefs,
  nodeRefs: Map<string, string>,
  expandedNodeIds: Set<string>,
): Record<string, unknown> {
  const id = nodeRefs.get(node.graphId);
  if (id && expandedNodeIds.has(node.graphId)) {
    return { id };
  }
  return formatNodeReadGraphNode(node, pathRefs, nodeRefs);
}

function formatSource(
  source: { filePath: string | null; startLine: number; endLine: number; text: string; missing?: boolean },
  pathRefs: AgentPathRefs,
): Record<string, unknown> {
  return removeUndefined({
    path: source.filePath ? pathRefs.pathToRef[source.filePath] : null,
    start: source.startLine,
    end: source.endLine,
    text: source.text,
    missing: source.missing,
  });
}

function displayQualifiedName(node: ViewNode): string | undefined {
  if (!node.qualifiedName || node.qualifiedName === node.name) {
    return undefined;
  }
  if (node.qualifiedName.startsWith("res://")) {
    return undefined;
  }
  return node.qualifiedName;
}

function formatSelectors(
  nodes: ViewNode[],
  relationships: ViewRelationship[],
  pathRefs: { pathToRef: Record<string, string> },
  nodeIntern: { idToRef: Record<string, string> },
): Record<string, AgentFormattedSelector> {
  const selectors: Record<string, AgentFormattedSelector> = {};
  const visibleNodeIds = new Set(nodes.map((node) => node.graphId));
  for (const node of nodes) {
    const ref = nodeIntern.idToRef[node.graphId];
    if (ref && needsGraphIdSelector(node)) {
      selectors[ref] = formatSelector(node, pathRefs);
    }
  }
  for (const endpointId of relationshipEndpointIds(relationships)) {
    if (visibleNodeIds.has(endpointId)) {
      continue;
    }
    const ref = nodeIntern.idToRef[endpointId];
    if (ref) {
      selectors[ref] = { id: endpointId };
    }
  }
  return selectors;
}

function formatSelector(
  node: ViewNode,
  pathRefs: { pathToRef: Record<string, string> },
): AgentFormattedSelector {
  const selector = node.selector ?? {
    id: node.graphId,
    kind: node.kind,
    path: viewNodeDisplayPath(node),
  };
  const path = selector.path ? pathRefs.pathToRef[selector.path] : undefined;
  return removeUndefined({
    id: path ? undefined : selector.id ?? node.graphId,
    kind: selector.kind ?? node.kind,
    path,
  });
}

function pathRefForNode(
  node: ViewNode,
  pathRefs: { pathToRef: Record<string, string> },
): string | undefined {
  const path = viewNodeDisplayPath(node);
  return path ? pathRefs.pathToRef[path] : undefined;
}

function needsGraphIdSelector(node: ViewNode): boolean {
  return node.kind === "scene_node" ||
    node.kind === "autoload" ||
    node.kind === "input_action" ||
    node.kind === "project" ||
    !node.filePath;
}

function formatRelationship(
  relationship: ViewRelationship,
  nodeIntern: { idToRef: Record<string, string> },
  pathRefs: { pathToRef: Record<string, string> },
): AgentFormattedRelationship {
  if (!relationship.source && relationship.kind === "related" && relationship.provenance === "text") {
    return {
      kind: "related",
      target: relationship.target,
      provenance: "text",
    };
  }

  const fromRef = nodeIntern.idToRef[relationship.source];
  const toRef = nodeIntern.idToRef[relationship.target];
  const targetPath = relationship.provenance === "unresolved" && relationship.target.startsWith("res://")
    ? pathRefs.pathToRef[relationship.target]
    : undefined;

  return removeUndefined({
    from: fromRef,
    kind: relationship.kind,
    to: toRef,
    targetPath,
    target: toRef || targetPath || relationship.provenance !== "unresolved"
      ? undefined
      : relationship.target,
    provenance: relationship.provenance,
  });
}

function formatBlastRadius(
  blastRadius: AgentBlastRadius,
  pathRefs: { pathToRef: Record<string, string> },
  nodeIntern: { idToRef: Record<string, string> },
): AgentFormattedBlastRadius {
  return {
    entryPoints: blastRadius.entryPoints
      .map((id) => nodeIntern.idToRef[id])
      .filter((id): id is string => Boolean(id)),
    checkFiles: blastRadius.checkFiles
      .map((path) => pathRefs.pathToRef[path])
      .filter((id): id is string => Boolean(id)),
    relationshipCount: blastRadius.relationshipCount,
  };
}

function pruneEmptyReferences(output: AgentFormattedContext): void {
  if (output.selectors && Object.keys(output.selectors).length === 0) {
    delete output.selectors;
  }
  if (output.prefixes) {
    const pathValues = Object.values(output.paths);
    for (const prefixRef of Object.keys(output.prefixes)) {
      if (!pathValues.some((path) => path.startsWith(`${prefixRef}/`))) {
        delete output.prefixes[prefixRef];
      }
    }
    if (Object.keys(output.prefixes).length === 0) {
      delete output.prefixes;
    }
  }
}

function pruneNodeReadPrefixes(output: AgentFormattedNodeRead): void {
  if (!output.prefixes) {
    return;
  }
  const pathValues = Object.values(output.paths);
  for (const prefixRef of Object.keys(output.prefixes)) {
    if (!pathValues.some((path) => path.startsWith(`${prefixRef}/`))) {
      delete output.prefixes[prefixRef];
    }
  }
  if (Object.keys(output.prefixes).length === 0) {
    delete output.prefixes;
  }
}

function assertContextOutputInvariants(output: AgentFormattedContext): void {
  const knownNodeRefs = new Set([
    ...output.nodes.map((node) => node.id),
    ...Object.keys(output.selectors ?? {}),
  ]);
  for (const relationship of [...output.relationships, ...output.pathsBetween]) {
    if (relationship.from && !knownNodeRefs.has(relationship.from)) {
      throw new AgentOutputInvariantError("unresolved_relationship_source");
    }
    if (relationship.to && !knownNodeRefs.has(relationship.to)) {
      throw new AgentOutputInvariantError("unresolved_relationship_target");
    }
  }

  const usedPathRefs = new Set<string>([
    ...output.nodes.flatMap((node) => node.path ? [node.path] : []),
    ...output.snippets.map((snippet) => snippet.path),
    ...output.relationships.flatMap(relationshipPathRefs),
    ...output.pathsBetween.flatMap(relationshipPathRefs),
    ...Object.values(output.selectors ?? {}).flatMap((selector) => selector.path ? [selector.path] : []),
    ...(output.blastRadius?.checkFiles ?? []),
  ]);

  for (const pathRef of Object.keys(output.paths)) {
    if (!usedPathRefs.has(pathRef)) {
      throw new AgentOutputInvariantError("orphan_context_path");
    }
  }
}

function assertNodeReadOutputInvariants(output: AgentFormattedNodeRead): void {
  const usedPathRefs = new Set<string>([
    ...pathRefsFromValue(output.target),
    ...(output.symbols ?? []).flatMap(pathRefsFromValue),
    ...Object.values(output.notes ?? {}).flatMap((value) =>
      Array.isArray(value) ? value.flatMap(pathRefsFromValue) : [],
    ),
    ...pathRefsFromValue(output.source ?? {}),
    ...(output.staleFiles ?? []),
  ]);

  for (const pathRef of Object.keys(output.paths)) {
    if (!usedPathRefs.has(pathRef)) {
      throw new AgentOutputInvariantError("orphan_node_read_path");
    }
  }
}

function pathRefsFromValue(value: unknown): string[] {
  if (!value || typeof value !== "object") {
    return [];
  }
  const maybePath = (value as { path?: unknown }).path;
  return typeof maybePath === "string" ? [maybePath] : [];
}

function relationshipPathRefs(relationship: AgentFormattedRelationship): string[] {
  return relationship.targetPath ? [relationship.targetPath] : [];
}

function stableEstimatedChars(output: AgentFormattedContext): number {
  let previous = output.budget.estimatedChars;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const next = estimatedChars(output);
    output.budget.estimatedChars = next;
    if (next === previous) {
      return next;
    }
    previous = next;
  }
  return output.budget.estimatedChars;
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
