import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { type GraphDatabase } from "../db/index.js";
import { getFile, getNode, listNodes, searchNodes } from "../db/queries.js";
import { loadGraphSnapshot, visibleEdges } from "../graph/traversal.js";
import { getScanAwareGraphFreshness } from "../sync/freshness.js";
import type { GraphNode } from "../types.js";
import { createAgentPathRefs, type AgentPathRefs } from "./agent-output.js";

const NODE_NOTE_LIMIT = 8;

interface RelationshipNoteEntry {
  node: GraphNode;
  priority: number;
  order: number;
}

interface RawRelationshipNotes {
  callers: GraphNode[];
  callees: GraphNode[];
  dependents: GraphNode[];
  dependencies: GraphNode[];
  limit: number;
  omitted: {
    callers: number;
    callees: number;
    dependents: number;
    dependencies: number;
  };
}

interface FilePayloadTarget {
  kind: "file";
  filePath: string;
  fileKind: string;
  nodeCount: number;
}

interface SourceWindowPayload {
  filePath: string | null;
  startLine: number;
  endLine: number;
  text: string;
  missing?: boolean;
}

export function getNodePayload(
  graph: GraphDatabase,
  projectRoot: string,
  args: Record<string, unknown>,
): Record<string, unknown> {
  const filePath = optionalString(args, "file");
  const nodeId = optionalString(args, "id");
  const symbol = optionalString(args, "symbol");
  const includeCode = optionalBoolean(args, "includeCode") ?? true;
  const symbolsOnly = optionalBoolean(args, "symbolsOnly") ?? false;

  if (!filePath && !nodeId && !symbol) {
    return {
      ok: false,
      error: "godot_node requires file, symbol, or id.",
    };
  }

  if (nodeId && (filePath || symbol)) {
    return {
      ok: false,
      error: "godot_node id selector cannot be combined with file or symbol.",
    };
  }

  if (symbol) {
    return getSymbolNodePayload(graph, projectRoot, symbol, filePath, includeCode, symbolsOnly);
  }

  if (filePath) {
    return getFileNodePayload(graph, projectRoot, filePath, args, includeCode, symbolsOnly);
  }

  const node = getNode(graph, nodeId!);
  if (!node) {
    return {
      ok: false,
      error: `No indexed graph node found for id: ${nodeId}`,
    };
  }

  const staleFilePaths = selectedStaleFilePaths(graph, projectRoot, node.filePath ? [node.filePath] : []);
  return formatNodePayload({
    target: node,
    symbols: symbolsOnly && node.filePath ? symbolsForFile(graph, node.filePath) : undefined,
    notes: relationshipNotesForNodes(graph, [node]),
    source: includeCode && !symbolsOnly && node.filePath ? sourceForNode(graph, projectRoot, node) : undefined,
    staleFilePaths,
  });
}

function getSymbolNodePayload(
  graph: GraphDatabase,
  projectRoot: string,
  symbol: string,
  filePath: string | null,
  includeCode: boolean,
  symbolsOnly: boolean,
): Record<string, unknown> {
  const node = findNodeForSymbol(graph, symbol, filePath);
  if (!node) {
    return {
      ok: false,
      error: filePath
        ? `No indexed symbol found: ${symbol} in ${filePath}`
        : `No indexed symbol found: ${symbol}`,
    };
  }

  const staleFilePaths = selectedStaleFilePaths(graph, projectRoot, node.filePath ? [node.filePath] : []);
  return formatNodePayload({
    target: node,
    symbols: symbolsOnly && node.filePath ? symbolsForFile(graph, node.filePath) : undefined,
    notes: relationshipNotesForNodes(graph, [node]),
    source: includeCode && !symbolsOnly && node.filePath ? sourceForNode(graph, projectRoot, node) : undefined,
    staleFilePaths,
  });
}

function getFileNodePayload(
  graph: GraphDatabase,
  projectRoot: string,
  filePath: string,
  args: Record<string, unknown>,
  includeCode: boolean,
  symbolsOnly: boolean,
): Record<string, unknown> {
  const file = getFile(graph, filePath);
  if (!file) {
    return {
      ok: false,
      error: `No indexed file found: ${filePath}`,
    };
  }

  const symbols = symbolsForFile(graph, filePath);
  const fileNodes = listNodes(graph).filter((node) => node.filePath === filePath);
  return formatNodePayload({
    target: {
      kind: "file",
      filePath,
      fileKind: file.kind,
      nodeCount: file.nodeCount,
    },
    symbols,
    notes: relationshipNotesForNodes(graph, fileNodes),
    source: includeCode && !symbolsOnly
      ? sourceWindow(projectRoot, filePath, {
          offset: optionalNumber(args, "offset") ?? 1,
          limit: optionalNumber(args, "limit") ?? 80,
        })
      : undefined,
    staleFilePaths: selectedStaleFilePaths(graph, projectRoot, [filePath]),
  });
}

function symbolsForFile(graph: GraphDatabase, filePath: string): GraphNode[] {
  return listNodes(graph)
    .filter((node) => node.filePath === filePath);
}

function findNodeForSymbol(graph: GraphDatabase, symbol: string, filePath: string | null): GraphNode | null {
  const matches = searchNodes(graph, symbol, 20).filter((node) =>
    filePath ? node.filePath === filePath : true,
  );
  return (
    matches.find((node) => node.name === symbol) ??
    matches.find((node) => node.qualifiedName === symbol) ??
    matches[0] ??
    null
  );
}

function formatNodePayload(input: {
  target: GraphNode | FilePayloadTarget;
  symbols?: GraphNode[];
  notes: RawRelationshipNotes;
  source?: SourceWindowPayload;
  staleFilePaths: string[];
}): Record<string, unknown> {
  const graphNodes = uniqueNodes([
    ...(isGraphNode(input.target) ? [input.target] : []),
    ...(input.symbols ?? []),
    ...input.notes.callers,
    ...input.notes.callees,
    ...input.notes.dependents,
    ...input.notes.dependencies,
  ]);
  const pathRefs = createAgentPathRefs(uniqueStrings([
    ...graphNodes.flatMap((node) => node.filePath ? [node.filePath] : []),
    ...(!isGraphNode(input.target) ? [input.target.filePath] : []),
    ...(input.source?.filePath ? [input.source.filePath] : []),
    ...input.staleFilePaths,
  ]));
  const nodeRefs = createNodeRefs(graphNodes);
  const expandedNodeIds = new Set([
    ...(isGraphNode(input.target) ? [input.target.id] : []),
    ...(input.symbols ?? []).map((node) => node.id),
  ]);

  return removeUndefined({
    ok: true,
    ...(Object.keys(pathRefs.prefixes).length > 0 ? { prefixes: pathRefs.prefixes } : {}),
    paths: pathRefs.paths,
    target: isGraphNode(input.target)
      ? formatGraphNode(input.target, pathRefs, nodeRefs)
      : formatFileTarget(input.target, pathRefs),
    symbols: input.symbols ? input.symbols.map((node) => formatGraphNode(node, pathRefs, nodeRefs)) : undefined,
    notes: formatRelationshipNotes(input.notes, pathRefs, nodeRefs, expandedNodeIds),
    source: input.source ? formatSource(input.source, pathRefs) : undefined,
    stale: input.staleFilePaths.length > 0 ? true : undefined,
    staleFiles: input.staleFilePaths.length > 0
      ? input.staleFilePaths
          .map((filePath) => pathRefs.pathToRef[filePath])
          .filter((path): path is string => Boolean(path))
      : undefined,
  });
}

function formatFileTarget(target: FilePayloadTarget, pathRefs: AgentPathRefs): Record<string, unknown> {
  return {
    kind: "file",
    path: pathRefs.pathToRef[target.filePath],
    fileKind: target.fileKind,
    nodeCount: target.nodeCount,
  };
}

function formatGraphNode(
  node: GraphNode,
  pathRefs: AgentPathRefs,
  nodeRefs: Map<string, string>,
): Record<string, unknown> {
  return removeUndefined({
    id: nodeRefs.get(node.id),
    kind: node.kind,
    name: node.name,
    qname: displayQualifiedName(node),
    path: node.filePath ? pathRefs.pathToRef[node.filePath] : undefined,
    line: node.startLine ?? undefined,
    signature: node.signature ?? undefined,
  });
}

function displayQualifiedName(node: GraphNode): string | undefined {
  if (!node.qualifiedName || node.qualifiedName === node.name) {
    return undefined;
  }
  if (node.qualifiedName.startsWith("res://")) {
    return undefined;
  }
  return node.qualifiedName;
}

function formatRelationshipNotes(
  notes: RawRelationshipNotes,
  pathRefs: AgentPathRefs,
  nodeRefs: Map<string, string>,
  expandedNodeIds: Set<string>,
): Record<string, unknown> {
  return {
    callers: notes.callers.map((node) => formatNoteNode(node, pathRefs, nodeRefs, expandedNodeIds)),
    callees: notes.callees.map((node) => formatNoteNode(node, pathRefs, nodeRefs, expandedNodeIds)),
    dependents: notes.dependents.map((node) => formatNoteNode(node, pathRefs, nodeRefs, expandedNodeIds)),
    dependencies: notes.dependencies.map((node) => formatNoteNode(node, pathRefs, nodeRefs, expandedNodeIds)),
    limit: notes.limit,
    omitted: notes.omitted,
  };
}

function formatNoteNode(
  node: GraphNode,
  pathRefs: AgentPathRefs,
  nodeRefs: Map<string, string>,
  expandedNodeIds: Set<string>,
): Record<string, unknown> {
  const id = nodeRefs.get(node.id);
  if (id && expandedNodeIds.has(node.id)) {
    return { id };
  }
  return formatGraphNode(node, pathRefs, nodeRefs);
}

function formatSource(source: SourceWindowPayload, pathRefs: AgentPathRefs): Record<string, unknown> {
  return removeUndefined({
    path: source.filePath ? pathRefs.pathToRef[source.filePath] : null,
    start: source.startLine,
    end: source.endLine,
    text: source.text,
    missing: source.missing,
  });
}

function createNodeRefs(nodes: GraphNode[]): Map<string, string> {
  return new Map(nodes.map((node, index) => [node.id, `n${index + 1}`]));
}

function isGraphNode(value: GraphNode | FilePayloadTarget): value is GraphNode {
  return "id" in value;
}

function relationshipNotesForNodes(graph: GraphDatabase, nodes: GraphNode[]): RawRelationshipNotes {
  const snapshot = loadGraphSnapshot(graph);
  const selectedIds = new Set(nodes.map((node) => node.id));
  const nodesById = new Map(snapshot.nodes.map((node) => [node.id, node]));
  const notes = {
    callers: [] as RelationshipNoteEntry[],
    callees: [] as RelationshipNoteEntry[],
    dependents: [] as RelationshipNoteEntry[],
    dependencies: [] as RelationshipNoteEntry[],
  };
  let order = 0;

  for (const edge of visibleEdges(snapshot)) {
    const sourceSelected = selectedIds.has(edge.source);
    const targetSelected = selectedIds.has(edge.target);
    if (!sourceSelected && !targetSelected) {
      continue;
    }

    if (targetSelected) {
      const source = nodesById.get(edge.source);
      const target = nodesById.get(edge.target);
      if (source && target) {
        const entry = {
          node: source,
          priority: relationshipNotePriority(edge.kind, source, target),
          order,
        };
        if (isBehaviorEdge(edge.kind)) {
          notes.callers.push(entry);
        } else {
          notes.dependents.push(entry);
        }
      }
    }

    if (sourceSelected) {
      const target = nodesById.get(edge.target);
      const source = nodesById.get(edge.source);
      if (source && target) {
        const entry = {
          node: target,
          priority: relationshipNotePriority(edge.kind, source, target),
          order,
        };
        if (isBehaviorEdge(edge.kind)) {
          notes.callees.push(entry);
        } else {
          notes.dependencies.push(entry);
        }
      }
    }

    order += 1;
  }

  const callers = summarizeNoteEntries(notes.callers);
  const callees = summarizeNoteEntries(notes.callees);
  const dependents = summarizeNoteEntries(notes.dependents);
  const dependencies = summarizeNoteEntries(notes.dependencies);

  return {
    callers: callers.nodes,
    callees: callees.nodes,
    dependents: dependents.nodes,
    dependencies: dependencies.nodes,
    limit: NODE_NOTE_LIMIT,
    omitted: {
      callers: callers.omitted,
      callees: callees.omitted,
      dependents: dependents.omitted,
      dependencies: dependencies.omitted,
    },
  };
}

function selectedStaleFilePaths(
  graph: GraphDatabase,
  projectRoot: string,
  filePaths: string[],
): string[] {
  const selected = new Set(filePaths);
  const freshness = getScanAwareGraphFreshness(projectRoot, graph);
  return freshness.pendingFiles
    .map((pending) => pending.path)
    .filter((path) => selected.has(path));
}

function isBehaviorEdge(kind: string): boolean {
  return kind === "calls" || kind === "connects_signal" || kind === "emits_signal";
}

function relationshipNotePriority(kind: string, source: GraphNode, target: GraphNode): number {
  if (kind === "references_symbol" && source.filePath !== target.filePath) {
    return 0;
  }
  if (kind === "references_symbol") {
    return 10;
  }
  if (isBehaviorEdge(kind) && source.filePath !== target.filePath) {
    return 20;
  }
  if (isBehaviorEdge(kind)) {
    return 30;
  }
  if (source.filePath !== target.filePath) {
    return 40;
  }
  if (kind === "contains") {
    return 60;
  }
  return 50;
}

function summarizeNoteEntries(
  entries: RelationshipNoteEntry[],
): { nodes: GraphNode[]; omitted: number } {
  const unique = uniqueRelationshipNoteEntries(
    [...entries].sort((a, b) => a.priority - b.priority || a.order - b.order),
  );
  return {
    nodes: unique.slice(0, NODE_NOTE_LIMIT).map((entry) => entry.node),
    omitted: Math.max(0, unique.length - NODE_NOTE_LIMIT),
  };
}

function uniqueRelationshipNoteEntries(entries: RelationshipNoteEntry[]): RelationshipNoteEntry[] {
  const seen = new Set<string>();
  return entries.filter((entry) => {
    if (seen.has(entry.node.id)) {
      return false;
    }
    seen.add(entry.node.id);
    return true;
  });
}

function sourceWindow(
  projectRoot: string,
  filePath: string,
  options: { offset: number; limit: number },
): SourceWindowPayload {
  const absolutePath = resPathToAbsolute(projectRoot, filePath);
  if (!existsSync(absolutePath)) {
    return {
      filePath,
      startLine: 1,
      endLine: 0,
      text: "",
      missing: true,
    };
  }

  const lines = readFileSync(absolutePath, "utf8").split(/\r?\n/);
  const startLine = clampInteger(options.offset, 1, Math.max(lines.length, 1));
  const limit = clampInteger(options.limit, 1, 200);
  const selected = lines.slice(startLine - 1, startLine - 1 + limit);
  return {
    filePath,
    startLine,
    endLine: startLine + selected.length - 1,
    text: selected.map((line, index) => `${startLine + index}\t${line}`).join("\n"),
  };
}

function sourceForNode(graph: GraphDatabase, projectRoot: string, node: GraphNode): SourceWindowPayload {
  if (!node.filePath) {
    return {
      filePath: null,
      startLine: 1,
      endLine: 0,
      text: "",
      missing: true,
    };
  }

  const startLine = node.startLine ?? 1;
  const endLine = node.endLine && node.endLine >= startLine
    ? node.endLine
    : inferredNodeEndLine(graph, node, startLine);
  if (!endLine) {
    return sourceWindow(projectRoot, node.filePath, {
      offset: startLine,
      limit: node.kind === "script_class" ? 80 : 24,
    });
  }

  return sourceWindow(projectRoot, node.filePath, {
    offset: startLine,
    limit: endLine - startLine + 1,
  });
}

function inferredNodeEndLine(graph: GraphDatabase, node: GraphNode, startLine: number): number | null {
  if (!node.filePath) {
    return null;
  }

  const nextStartLine = listNodes(graph)
    .filter((candidate) =>
      candidate.filePath === node.filePath &&
      candidate.id !== node.id &&
      candidate.startLine !== null &&
      candidate.startLine > startLine,
    )
    .map((candidate) => candidate.startLine!)
    .sort((left, right) => left - right)[0];
  return nextStartLine ? nextStartLine - 1 : null;
}

function resPathToAbsolute(projectRoot: string, filePath: string): string {
  return join(projectRoot, filePath.replace(/^res:\/\//, ""));
}

function clampInteger(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) {
    return min;
  }
  return Math.max(min, Math.min(max, Math.trunc(value)));
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

function removeUndefined<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(
    Object.entries(value).filter(([, entryValue]) => entryValue !== undefined),
  ) as T;
}

function optionalNumber(args: Record<string, unknown>, key: string): number | null {
  const value = args[key];
  return typeof value === "number" ? value : null;
}

function optionalString(args: Record<string, unknown>, key: string): string | null {
  const value = args[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function optionalBoolean(args: Record<string, unknown>, key: string): boolean | null {
  const value = args[key];
  return typeof value === "boolean" ? value : null;
}
