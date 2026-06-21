import { existsSync } from "node:fs";
import { join, resolve } from "node:path";

import {
  exploreGodotContext,
  getCalleesContext,
  getCallersContext,
  getSymbolContext,
} from "../context/explore.js";
import { createGraphDatabase } from "../db/index.js";
import { getImpactContext } from "../graph/impact.js";
import {
  getProjectMap,
  getProjectOverview,
  getSceneDetails,
  getSceneMap,
} from "../graph/queries.js";
import { searchGraph } from "../search/index.js";
import { attachFreshness, getScanAwareGraphFreshness } from "../sync/freshness.js";
import { syncGodotProject } from "../sync/index.js";
import { globalPendingFileTracker } from "../sync/watcher.js";
import { errorMessage, logMcpError } from "./logging.js";

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
      description: "Primary first call for Godot code, scene, resource, signal, and node-path questions. Returns bounded context plus next recommended graph tools.",
      inputSchema: contextQuerySchema("query"),
    },
    {
      name: "godot_project_map",
      description: "Return a large top-level Godot project map. Use cautiously, only when a top-level architecture/design overview is needed.",
      inputSchema: projectPathSchema(),
    },
    {
      name: "godot_sync",
      description: "Synchronize changed Godot files into the graph index and return freshness metadata.",
      inputSchema: projectPathSchema(),
    },
    {
      name: "godot_search",
      description: "Search indexed Godot graph nodes by symbol, scene, script, signal, or resource text.",
      inputSchema: {
        type: "object",
        properties: {
          projectPath: { type: "string" },
          query: { type: "string" },
          limit: { type: "number" },
        },
        required: ["query"],
      },
    },
    {
      name: "godot_scene",
      description: "Return indexed scene details including scene nodes for a .tscn resource path.",
      inputSchema: {
        type: "object",
        properties: {
          projectPath: { type: "string" },
          scenePath: { type: "string" },
        },
        required: ["scenePath"],
      },
    },
    {
      name: "godot_explore",
      description: "Return an Agent-ready context package for a Godot feature, symbol, scene, or resource query.",
      inputSchema: contextQuerySchema("query"),
    },
    {
      name: "godot_symbol",
      description: "Return symbol details, nearby relationships, and optional source snippets.",
      inputSchema: contextQuerySchema("symbol"),
    },
    {
      name: "godot_callers",
      description: "Return caller context for a method, signal, script, or symbol.",
      inputSchema: contextQuerySchema("symbol"),
    },
    {
      name: "godot_callees",
      description: "Return callee/outgoing context for a method, signal, script, or symbol.",
      inputSchema: contextQuerySchema("symbol"),
    },
    {
      name: "godot_impact",
      description: "Return likely impacted scenes, scripts, resources, relationships, and check files before editing.",
      inputSchema: contextQuerySchema("target"),
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
    return withInitializedGraph(projectRootFromArgs(args), (graph, projectRoot) => ({
      ok: true,
      query,
      ...indexSummary(graph),
      context: exploreGodotContext(graph, {
        projectRoot,
        query,
        maxFiles: optionalNumber(args, "maxFiles") ?? 6,
        includeCode: optionalBoolean(args, "includeCode") ?? false,
      }),
      nextTools: [
        {
          tool: "godot_search",
          reason: "Use for focused symbol, scene, script, signal, or resource follow-up.",
        },
        {
          tool: "godot_scene",
          reason: "Use when the context identifies a specific .tscn scene path.",
        },
        {
          tool: "godot_impact",
          reason: "Use before editing a matched script, scene, resource, signal, or call chain.",
        },
      ],
    }));
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
          {
            ...result,
            addedCount: result.added.length,
            modifiedCount: result.modified.length,
            deletedCount: result.deleted.length,
          },
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
      ...indexSummary(graph),
      results: searchGraph(graph, query, limit),
    }));
  }

  if (name === "godot_scene") {
    const scenePath = requiredString(args, "scenePath");
    return withInitializedGraph(projectRootFromArgs(args), (graph) => ({
      ok: true,
      scenePath,
      ...getSceneMap(graph, scenePath),
    }));
  }

  if (name === "godot_explore") {
    const query = requiredString(args, "query");
    return withInitializedGraph(projectRootFromArgs(args), (graph, projectRoot) => ({
      ok: true,
      ...exploreGodotContext(graph, {
        projectRoot,
        query,
        maxFiles: optionalNumber(args, "maxFiles") ?? 6,
        includeCode: optionalBoolean(args, "includeCode") ?? true,
      }),
    }));
  }

  if (name === "godot_symbol") {
    const symbol = requiredString(args, "symbol");
    return withInitializedGraph(projectRootFromArgs(args), (graph, projectRoot) => ({
      ok: true,
      ...getSymbolContext(graph, {
        projectRoot,
        symbol,
        maxFiles: optionalNumber(args, "maxFiles") ?? 6,
        includeCode: optionalBoolean(args, "includeCode") ?? true,
      }),
    }));
  }

  if (name === "godot_callers") {
    const symbol = requiredString(args, "symbol");
    return withInitializedGraph(projectRootFromArgs(args), (graph, projectRoot) => ({
      ok: true,
      ...getCallersContext(graph, {
        projectRoot,
        symbol,
        maxFiles: optionalNumber(args, "maxFiles") ?? 6,
        includeCode: optionalBoolean(args, "includeCode") ?? true,
      }),
    }));
  }

  if (name === "godot_callees") {
    const symbol = requiredString(args, "symbol");
    return withInitializedGraph(projectRootFromArgs(args), (graph, projectRoot) => ({
      ok: true,
      ...getCalleesContext(graph, {
        projectRoot,
        symbol,
        maxFiles: optionalNumber(args, "maxFiles") ?? 6,
        includeCode: optionalBoolean(args, "includeCode") ?? true,
      }),
    }));
  }

  if (name === "godot_impact") {
    const target = requiredString(args, "target");
    return withInitializedGraph(projectRootFromArgs(args), (graph) => ({
      ok: true,
      ...getImpactContext(graph, target),
    }));
  }

  return jsonToolResult({
    ok: false,
    error: `Unknown tool: ${name}`,
  });
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
      message: "No gdgraph index found. Run gdgraph init, gdgraph index, or godot_sync first.",
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

function jsonToolResult(payload: unknown): GodotMcpToolResult {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(payload, null, 2),
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

function optionalBoolean(args: Record<string, unknown>, key: string): boolean | null {
  const value = args[key];
  return typeof value === "boolean" ? value : null;
}
