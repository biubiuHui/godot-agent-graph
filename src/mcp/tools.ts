import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import {
  exploreGodotContext,
  getCalleesContext,
  getCallersContext,
  getSymbolContext,
  type AgentContext,
  type AgentNodeSummary,
} from "../context/explore.js";
import {
  createAgentPathRefs,
  formatAgentContext,
  type AgentFormattedNode,
} from "../context/agent-output.js";
import { createGraphDatabase } from "../db/index.js";
import { getFile, getNode, listNodes, searchNodes } from "../db/queries.js";
import { getImpactContext, type ImpactContext, type ImpactNodeSummary } from "../graph/impact.js";
import {
  getProjectMap,
  getProjectOverview,
  getSceneMap,
} from "../graph/queries.js";
import { loadGraphSnapshot, visibleEdges } from "../graph/traversal.js";
import { searchGraph } from "../search/index.js";
import { attachFreshness, getScanAwareGraphFreshness } from "../sync/freshness.js";
import { syncGodotProject, type SyncGodotProjectOk } from "../sync/index.js";
import { globalPendingFileTracker } from "../sync/watcher.js";
import type { GraphNode } from "../types.js";
import { errorMessage, logMcpError } from "./logging.js";

const MCP_SYNC_LIST_LIMIT = 20;
const MCP_SEARCH_MAX_CHARS = 3_200;
const MCP_LEGACY_CONTEXT_MAX_CHARS = 7_200;
const MCP_IMPACT_MAX_CHARS = 4_800;
const MCP_SEARCH_NODE_LIMIT = 12;
const MCP_SCENE_NODE_LIMIT = 80;

export interface GodotMcpToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
  };
}

export interface GodotMcpToolResult {
  [key: string]: unknown;
  content: Array<{ type: "text"; text: string }>;
}

export function listGodotMcpTools(): GodotMcpToolDefinition[] {
  return [
    {
      name: "godot_status",
      description: "Return gdgraph index status and freshness metadata for a Godot project.",
      inputSchema: projectPathSchema(),
    },
    {
      name: "godot_context",
      description: "Primary first call for Godot code, scene, resource, signal, node-path, flow, and edit-planning questions.",
      inputSchema: contextQuerySchema("query"),
    },
    {
      name: "godot_node",
      description: "Read indexed source for a Godot file, graph node id, or symbol without falling back to raw file reads.",
      inputSchema: nodeQuerySchema(),
    },
    {
      name: "godot_sync",
      description: "Synchronize changed Godot files into the graph index and return freshness metadata.",
      inputSchema: projectPathSchema(),
    },
  ];
}

export function callGodotMcpTool(
  name: string,
  args: Record<string, unknown> = {},
): GodotMcpToolResult {
  try {
    return callGodotMcpToolUnsafe(name, args);
  } catch (error) {
    logMcpError("tool_failed", error, {
      tool: name,
      projectRoot: safeProjectRootFromArgs(args),
    });
    return jsonToolResult({
      ok: false,
      tool: name,
      error: errorMessage(error),
    });
  }
}

function callGodotMcpToolUnsafe(
  name: string,
  args: Record<string, unknown> = {},
): GodotMcpToolResult {
  if (name === "godot_status") {
    return jsonToolResult(statusPayload(projectRootFromArgs(args)));
  }

  if (name === "godot_project_map") {
    return withInitializedGraph(projectRootFromArgs(args), (graph) => {
      return {
        ok: true,
        ...getProjectMap(graph),
      };
    });
  }

  if (name === "godot_context") {
    const query = requiredString(args, "query");
    return withInitializedGraph(projectRootFromArgs(args), (graph, projectRoot) => {
      const context = exploreGodotContext(graph, {
        projectRoot,
        query,
        maxFiles: optionalNumber(args, "maxFiles") ?? 6,
        includeCode: optionalBoolean(args, "includeCode") ?? false,
      });
      return {
        ok: true,
        query,
        ...indexSummary(graph),
        context: formatAgentContext(context, {
          maxChars: 4_800,
          maxNodes: 40,
          maxRelationships: 40,
          maxSnippets: 6,
        }),
        nextTools: [
          {
            tool: "godot_node",
            reason: "Use for indexed source reads when a specific file, symbol, or graph node needs source.",
          },
          {
            tool: "godot_status",
            reason: "Use to inspect freshness when context indicates stale or pending indexed files.",
          },
          {
            tool: "godot_sync",
            reason: "Use only when indexFresh=false or watcher catch-up is unavailable.",
          },
        ],
      };
    });
  }

  if (name === "godot_node") {
    return withInitializedGraph(projectRootFromArgs(args), (graph, projectRoot) =>
      getNodePayload(graph, projectRoot, args),
    );
  }

  if (name === "godot_sync") {
    const projectRoot = projectRootFromArgs(args);
    const result = syncGodotProject(projectRoot);
    if (!result.ok) {
      return jsonToolResult(result);
    }

    globalPendingFileTracker.clearPending(projectRoot);
    const graph = createGraphDatabase(projectRoot);
    try {
      return jsonToolResult(
        attachFreshness(
          compactSyncPayload(result),
          getScanAwareGraphFreshness(projectRoot, graph),
        ),
      );
    } finally {
      graph.close();
    }
  }

  if (name === "godot_search") {
    const query = requiredString(args, "query");
    const limit = optionalNumber(args, "limit") ?? 20;
    return withInitializedGraph(projectRootFromArgs(args), (graph) => ({
      ok: true,
      query,
      ...compactSearchPayload(searchGraph(graph, query, limit), query),
    }));
  }

  if (name === "godot_scene") {
    const scenePath = requiredString(args, "scenePath");
    return withInitializedGraph(projectRootFromArgs(args), (graph) => ({
      ok: true,
      scenePath,
      ...compactScenePayload(getSceneMap(graph, scenePath)),
    }));
  }

  if (name === "godot_explore") {
    const query = requiredString(args, "query");
    return withInitializedGraph(projectRootFromArgs(args), (graph, projectRoot) => {
      const context = exploreGodotContext(graph, {
        projectRoot,
        query,
        maxFiles: optionalNumber(args, "maxFiles") ?? 6,
        includeCode: optionalBoolean(args, "includeCode") ?? true,
      });
      return compactLegacyContextPayload(graph, "query", query, context);
    });
  }

  if (name === "godot_symbol") {
    const symbol = requiredString(args, "symbol");
    return withInitializedGraph(projectRootFromArgs(args), (graph, projectRoot) => {
      const context = getSymbolContext(graph, {
        projectRoot,
        symbol,
        maxFiles: optionalNumber(args, "maxFiles") ?? 6,
        includeCode: optionalBoolean(args, "includeCode") ?? true,
      });
      return compactLegacyContextPayload(graph, "symbol", symbol, context);
    });
  }

  if (name === "godot_callers") {
    const symbol = requiredString(args, "symbol");
    return withInitializedGraph(projectRootFromArgs(args), (graph, projectRoot) => {
      const context = getCallersContext(graph, {
        projectRoot,
        symbol,
        maxFiles: optionalNumber(args, "maxFiles") ?? 6,
        includeCode: optionalBoolean(args, "includeCode") ?? true,
      });
      return compactLegacyContextPayload(graph, "symbol", symbol, context);
    });
  }

  if (name === "godot_callees") {
    const symbol = requiredString(args, "symbol");
    return withInitializedGraph(projectRootFromArgs(args), (graph, projectRoot) => {
      const context = getCalleesContext(graph, {
        projectRoot,
        symbol,
        maxFiles: optionalNumber(args, "maxFiles") ?? 6,
        includeCode: optionalBoolean(args, "includeCode") ?? true,
      });
      return compactLegacyContextPayload(graph, "symbol", symbol, context);
    });
  }

  if (name === "godot_impact") {
    const target = requiredString(args, "target");
    return withInitializedGraph(projectRootFromArgs(args), (graph) => ({
      ok: true,
      ...compactImpactPayload(target, getImpactContext(graph, target)),
    }));
  }

  return jsonToolResult({
    ok: false,
    error: `Unknown tool: ${name}`,
  });
}

function compactSyncPayload(result: SyncGodotProjectOk): Record<string, unknown> {
  const added = summarizeSyncList(result.added);
  const modified = summarizeSyncList(result.modified);
  const deleted = summarizeSyncList(result.deleted);

  return {
    ...result,
    added: added.paths,
    modified: modified.paths,
    deleted: deleted.paths,
    addedCount: result.added.length,
    modifiedCount: result.modified.length,
    deletedCount: result.deleted.length,
    addedOmitted: added.omitted,
    modifiedOmitted: modified.omitted,
    deletedOmitted: deleted.omitted,
    changeListLimit: MCP_SYNC_LIST_LIMIT,
  };
}

function summarizeSyncList(paths: string[]): { paths: string[]; omitted: number } {
  return {
    paths: paths.slice(0, MCP_SYNC_LIST_LIMIT),
    omitted: Math.max(0, paths.length - MCP_SYNC_LIST_LIMIT),
  };
}

function compactLegacyContextPayload(
  graph: ReturnType<typeof createGraphDatabase>,
  label: "query" | "symbol",
  value: string,
  context: AgentContext,
): Record<string, unknown> {
  return {
    ok: true,
    [label]: value,
    context: formatAgentContext(context, {
      maxChars: MCP_LEGACY_CONTEXT_MAX_CHARS,
      maxNodes: 40,
      maxRelationships: 40,
      maxSnippets: 6,
    }),
  };
}

function compactSearchPayload(nodes: GraphNode[], query: string): Record<string, unknown> {
  const visibleNodes = nodes.slice(0, MCP_SEARCH_NODE_LIMIT);
  const formatted = formatAgentContext(
    {
      query,
      entryPoints: visibleNodes.map((node) => node.id),
      nodes: visibleNodes.map(graphNodeToAgentSummary),
      relationships: [],
      files: visibleNodes.flatMap((node) => (node.filePath ? [node.filePath] : [])),
      snippets: [],
    },
    {
      maxChars: MCP_SEARCH_MAX_CHARS,
      maxNodes: 40,
      maxRelationships: 0,
      maxSnippets: 0,
    },
  );

  return compactObject({
    prefixes: formatted.prefixes,
    paths: formatted.paths,
    results: formatted.nodes,
    truncated: formatted.truncated,
    omitted: {
      ...formatted.omitted,
      nodes: formatted.omitted.nodes + Math.max(0, nodes.length - visibleNodes.length),
    },
    budget: formatted.budget,
  });
}

function compactScenePayload(sceneMap: ReturnType<typeof getSceneMap>): Record<string, unknown> {
  const rawPaths = [
    sceneMap.scene?.path,
    ...sceneMap.nodes.flatMap((node) => [node.scriptPath, node.instanceScenePath]),
  ].filter((path): path is string => typeof path === "string" && path.length > 0);
  const pathRefs = createAgentPathRefs(rawPaths);
  const visibleNodes = sceneMap.nodes.slice(0, MCP_SCENE_NODE_LIMIT);

  return compactObject({
    prefixes: Object.keys(pathRefs.prefixes).length > 0 ? pathRefs.prefixes : undefined,
    paths: pathRefs.paths,
    scene: sceneMap.scene
      ? compactObject({
          id: "n1",
          graphId: sceneMap.scene.id,
          name: sceneMap.scene.name,
          path: pathRefs.pathToRef[sceneMap.scene.path],
        })
      : null,
    nodes: visibleNodes.map((node, index) =>
      compactObject({
        id: `n${index + 2}`,
        graphId: node.id,
        name: node.name,
        path: node.path,
        type: node.type,
        parentPath: node.parentPath,
        scriptPath: node.scriptPath ? pathRefs.pathToRef[node.scriptPath] : null,
        instanceScenePath: node.instanceScenePath ? pathRefs.pathToRef[node.instanceScenePath] : null,
        line: node.line,
      }),
    ),
    truncated: sceneMap.nodes.length > visibleNodes.length,
    omitted: {
      nodes: Math.max(0, sceneMap.nodes.length - visibleNodes.length),
    },
  });
}

function compactImpactPayload(targetQuery: string, impact: ImpactContext): Record<string, unknown> {
  if (!impact.target) {
    return {
      ...impact,
      query: targetQuery,
    };
  }

  const impactNodes = uniqueImpactNodes([
    impact.target,
    ...impact.affectedScenes,
    ...impact.affectedScripts,
    ...impact.affectedResources,
  ]);
  const pathRefs = createAgentPathRefs([
    ...impact.recommendedCheckFiles,
    ...impactNodes.flatMap((node) => (node.filePath ? [node.filePath] : [])),
  ]);
  const formatted = formatAgentContext(
    {
      query: targetQuery,
      entryPoints: [impact.target.id],
      nodes: impactNodes.map(impactNodeToAgentSummary),
      relationships: impact.relationships,
      files: impact.recommendedCheckFiles,
      snippets: [],
    },
    {
      maxChars: MCP_IMPACT_MAX_CHARS,
      maxNodes: 40,
      maxRelationships: 40,
      maxSnippets: 0,
    },
  );
  const formattedByGraphId = new Map(formatted.nodes.map((node) => [node.graphId, node]));
  const compactImpactNode = (node: ImpactNodeSummary): AgentFormattedNode | null =>
    formattedByGraphId.get(node.id) ?? null;

  return compactObject({
    query: targetQuery,
    prefixes: formatted.prefixes,
    paths: formatted.paths,
    target: compactImpactNode(impact.target),
    affectedScenes: compactImpactNodes(impact.affectedScenes, compactImpactNode),
    affectedScripts: compactImpactNodes(impact.affectedScripts, compactImpactNode),
    affectedResources: compactImpactNodes(impact.affectedResources, compactImpactNode),
    relationships: formatted.relationships,
    recommendedCheckFiles: impact.recommendedCheckFiles
      .map((path) => pathRefs.pathToRef[path])
      .filter((path): path is string => Boolean(path)),
    omitted: {
      ...impact.omitted,
      formatted: formatted.omitted,
    },
    truncated: formatted.truncated,
    budget: formatted.budget,
  });
}

function compactImpactNodes(
  nodes: ImpactNodeSummary[],
  compactImpactNode: (node: ImpactNodeSummary) => AgentFormattedNode | null,
): AgentFormattedNode[] {
  return nodes
    .map((node) => compactImpactNode(node))
    .filter((node): node is AgentFormattedNode => node !== null);
}

function uniqueImpactNodes(nodes: ImpactNodeSummary[]): ImpactNodeSummary[] {
  const seen = new Set<string>();
  return nodes.filter((node) => {
    if (seen.has(node.id)) {
      return false;
    }
    seen.add(node.id);
    return true;
  });
}

function graphNodeToAgentSummary(node: GraphNode): AgentNodeSummary {
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

function impactNodeToAgentSummary(node: ImpactNodeSummary): AgentNodeSummary {
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

function compactObject<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(
    Object.entries(value).filter(([, entryValue]) => entryValue !== undefined),
  ) as T;
}

function projectPathSchema(): GodotMcpToolDefinition["inputSchema"] {
  return {
    type: "object",
    properties: {
      projectPath: { type: "string" },
    },
  };
}

function contextQuerySchema(requiredField: string): GodotMcpToolDefinition["inputSchema"] {
  return {
    type: "object",
    properties: {
      projectPath: { type: "string" },
      [requiredField]: { type: "string" },
      maxFiles: { type: "number" },
      includeCode: { type: "boolean" },
    },
    required: [requiredField],
  };
}

function nodeQuerySchema(): GodotMcpToolDefinition["inputSchema"] {
  return {
    type: "object",
    properties: {
      projectPath: { type: "string" },
      id: { type: "string" },
      symbol: { type: "string" },
      file: { type: "string" },
      offset: { type: "number" },
      limit: { type: "number" },
      includeCode: { type: "boolean" },
      symbolsOnly: { type: "boolean" },
    },
  };
}

function withInitializedGraph(
  projectRoot: string,
  callback: (graph: ReturnType<typeof createGraphDatabase>, projectRoot: string) => Record<string, unknown>,
): GodotMcpToolResult {
  const status = statusPayload(projectRoot);
  if (!status.ok) {
    return jsonToolResult(status);
  }

  const graph = createGraphDatabase(projectRoot);
  try {
    return jsonToolResult(
      attachFreshness(callback(graph, projectRoot), getScanAwareGraphFreshness(projectRoot, graph)),
    );
  } finally {
    graph.close();
  }
}

function statusPayload(projectRoot: string): Record<string, unknown> {
  const dbPath = join(projectRoot, ".gdgraph", "graph.db");
  if (!existsSync(dbPath)) {
    return {
      ok: false,
      initialized: false,
      indexFresh: false,
      pendingFiles: [],
      watcher: "disabled",
      lastSyncAt: null,
      lastSyncAtSource: "unknown",
      message: "No gdgraph index found. Run gdgraph init, gdgraph index, or godot_sync first.",
      nextTools: missingIndexNextTools("initialized=false"),
    };
  }

  const graph = createGraphDatabase(projectRoot);
  try {
    const overview = getProjectOverview(graph);
    const freshness = getScanAwareGraphFreshness(projectRoot, graph);
    const indexEmpty = overview.fileCount === 0 && overview.nodeCount === 0;
    if (indexEmpty) {
      return {
        ok: false,
        initialized: true,
        indexEmpty,
        fileCount: overview.fileCount,
        nodeCount: overview.nodeCount,
        edgeCount: overview.edgeCount,
        unresolvedRefCount: overview.unresolvedRefCount,
        ...freshness,
        indexFresh: false,
        message: "The gdgraph index exists but is empty. Run gdgraph sync, gdgraph index, or godot_sync before relying on graph answers.",
        nextTools: missingIndexNextTools("indexEmpty=true"),
      };
    }

    return {
      ok: true,
      initialized: true,
      indexEmpty,
      fileCount: overview.fileCount,
      nodeCount: overview.nodeCount,
      edgeCount: overview.edgeCount,
      unresolvedRefCount: overview.unresolvedRefCount,
      ...freshness,
    };
  } finally {
    graph.close();
  }
}

function missingIndexNextTools(reasonState: "initialized=false" | "indexEmpty=true"): Array<Record<string, string>> {
  return [
    {
      tool: "godot_sync",
      reason: `Run manually once before graph queries when ${reasonState} or no usable gdgraph index exists.`,
    },
  ];
}

function jsonToolResult(payload: unknown): GodotMcpToolResult {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(payload),
      },
    ],
  };
}

function projectRootFromArgs(args: Record<string, unknown>): string {
  return resolve(typeof args.projectPath === "string" ? args.projectPath : ".");
}

function safeProjectRootFromArgs(args: Record<string, unknown>): string | null {
  try {
    return projectRootFromArgs(args);
  } catch {
    return null;
  }
}

function indexSummary(graph: ReturnType<typeof createGraphDatabase>): Record<string, unknown> {
  const overview = getProjectOverview(graph);
  return {
    fileCount: overview.fileCount,
    nodeCount: overview.nodeCount,
    edgeCount: overview.edgeCount,
    unresolvedRefCount: overview.unresolvedRefCount,
    indexEmpty: overview.fileCount === 0 && overview.nodeCount === 0,
  };
}

function requiredString(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${key} is required`);
  }

  return value;
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

function getNodePayload(
  graph: ReturnType<typeof createGraphDatabase>,
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

  if (filePath) {
    return getFileNodePayload(graph, projectRoot, filePath, args, includeCode, symbolsOnly);
  }

  const node = nodeId ? getNode(graph, nodeId) : findNodeForSymbol(graph, symbol!, optionalString(args, "file"));
  if (!node) {
    return {
      ok: false,
      error: nodeId ? `No indexed graph node found for id: ${nodeId}` : `No indexed symbol found: ${symbol}`,
    };
  }

  const payload: Record<string, unknown> = {
    ok: true,
    target: summarizeNode(node),
    notes: relationshipNotesForNodes(graph, [node]),
  };
  attachSelectedStaleFiles(payload, graph, projectRoot, node.filePath ? [node.filePath] : []);

  if (includeCode && !symbolsOnly && node.filePath) {
    payload.source = sourceForNode(graph, projectRoot, node);
  }

  return payload;
}

function getFileNodePayload(
  graph: ReturnType<typeof createGraphDatabase>,
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

  const symbols = listNodes(graph)
    .filter((node) => node.filePath === filePath)
    .map(summarizeNode);
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

function findNodeForSymbol(
  graph: ReturnType<typeof createGraphDatabase>,
  symbol: string,
  filePath: string | null,
): GraphNode | null {
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

function relationshipNotesForNodes(
  graph: ReturnType<typeof createGraphDatabase>,
  nodes: GraphNode[],
): Record<string, unknown> {
  const snapshot = loadGraphSnapshot(graph);
  const selectedIds = new Set(nodes.map((node) => node.id));
  const nodesById = new Map(snapshot.nodes.map((node) => [node.id, node]));
  const notes = {
    callers: [] as GraphNode[],
    callees: [] as GraphNode[],
    dependents: [] as GraphNode[],
    dependencies: [] as GraphNode[],
  };

  for (const edge of visibleEdges(snapshot)) {
    const sourceSelected = selectedIds.has(edge.source);
    const targetSelected = selectedIds.has(edge.target);
    if (!sourceSelected && !targetSelected) {
      continue;
    }

    if (targetSelected) {
      const source = nodesById.get(edge.source);
      if (source) {
        if (isBehaviorEdge(edge.kind)) {
          notes.callers.push(source);
        } else {
          notes.dependents.push(source);
        }
      }
    }

    if (sourceSelected) {
      const target = nodesById.get(edge.target);
      if (target) {
        if (isBehaviorEdge(edge.kind)) {
          notes.callees.push(target);
        } else {
          notes.dependencies.push(target);
        }
      }
    }
  }

  return {
    callers: uniqueGraphNodes(notes.callers).slice(0, 8).map(summarizeNode),
    callees: uniqueGraphNodes(notes.callees).slice(0, 8).map(summarizeNode),
    dependents: uniqueGraphNodes(notes.dependents).slice(0, 8).map(summarizeNode),
    dependencies: uniqueGraphNodes(notes.dependencies).slice(0, 8).map(summarizeNode),
  };
}

function attachSelectedStaleFiles(
  payload: Record<string, unknown>,
  graph: ReturnType<typeof createGraphDatabase>,
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

function uniqueGraphNodes(nodes: GraphNode[]): GraphNode[] {
  const seen = new Set<string>();
  return nodes.filter((node) => {
    if (seen.has(node.id)) {
      return false;
    }
    seen.add(node.id);
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

function sourceForNode(
  graph: ReturnType<typeof createGraphDatabase>,
  projectRoot: string,
  node: GraphNode,
): Record<string, unknown> {
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

function inferredNodeEndLine(
  graph: ReturnType<typeof createGraphDatabase>,
  node: GraphNode,
  startLine: number,
): number | null {
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
