import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { type GraphDatabase } from "../db/index.js";
import { getFile, getNode, listNodes, searchNodes } from "../db/queries.js";
import { loadGraphSnapshot, visibleEdges } from "../graph/traversal.js";
import { getScanAwareGraphFreshness } from "../sync/freshness.js";
import type { GraphNode } from "../types.js";

const NODE_NOTE_LIMIT = 8;

interface RelationshipNoteEntry {
  node: GraphNode;
  priority: number;
  order: number;
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

  const payload: Record<string, unknown> = {
    ok: true,
    target: summarizeNode(node),
    notes: relationshipNotesForNodes(graph, [node]),
  };
  attachSelectedStaleFiles(payload, graph, projectRoot, node.filePath ? [node.filePath] : []);

  if (symbolsOnly && node.filePath) {
    payload.symbols = symbolsForFile(graph, node.filePath);
  }

  if (includeCode && !symbolsOnly && node.filePath) {
    payload.source = sourceForNode(graph, projectRoot, node);
  }

  return payload;
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

  const payload: Record<string, unknown> = {
    ok: true,
    target: summarizeNode(node),
    notes: relationshipNotesForNodes(graph, [node]),
  };
  attachSelectedStaleFiles(payload, graph, projectRoot, node.filePath ? [node.filePath] : []);

  if (symbolsOnly && node.filePath) {
    payload.symbols = symbolsForFile(graph, node.filePath);
  }

  if (includeCode && !symbolsOnly && node.filePath) {
    payload.source = sourceForNode(graph, projectRoot, node);
  }

  return payload;
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
  const payload: Record<string, unknown> = {
    ok: true,
    target: {
      kind: "file",
      filePath,
      fileKind: file.kind,
      nodeCount: file.nodeCount,
    },
    symbols,
    notes: relationshipNotesForNodes(
      graph,
      listNodes(graph).filter((node) => node.filePath === filePath),
    ),
  };
  attachSelectedStaleFiles(payload, graph, projectRoot, [filePath]);

  if (includeCode && !symbolsOnly) {
    payload.source = sourceWindow(projectRoot, filePath, {
      offset: optionalNumber(args, "offset") ?? 1,
      limit: optionalNumber(args, "limit") ?? 80,
    });
  }

  return payload;
}

function symbolsForFile(graph: GraphDatabase, filePath: string): Array<Record<string, unknown>> {
  return listNodes(graph)
    .filter((node) => node.filePath === filePath)
    .map(summarizeNode);
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

function summarizeNode(node: GraphNode): Record<string, unknown> {
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

function relationshipNotesForNodes(graph: GraphDatabase, nodes: GraphNode[]): Record<string, unknown> {
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

function attachSelectedStaleFiles(
  payload: Record<string, unknown>,
  graph: GraphDatabase,
  projectRoot: string,
  filePaths: string[],
): void {
  const selected = new Set(filePaths);
  const freshness = getScanAwareGraphFreshness(projectRoot, graph);
  const staleFiles = freshness.pendingFiles
    .map((pending) => pending.path)
    .filter((path) => selected.has(path));
  if (staleFiles.length > 0) {
    payload.stale = true;
    payload.staleFiles = staleFiles;
  }
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
): { nodes: Array<Record<string, unknown>>; omitted: number } {
  const unique = uniqueRelationshipNoteEntries(
    [...entries].sort((a, b) => a.priority - b.priority || a.order - b.order),
  );
  return {
    nodes: unique.slice(0, NODE_NOTE_LIMIT).map((entry) => summarizeNode(entry.node)),
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
): Record<string, unknown> {
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

function sourceForNode(graph: GraphDatabase, projectRoot: string, node: GraphNode): Record<string, unknown> {
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
