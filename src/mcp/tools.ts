import { existsSync } from "node:fs";
import { join, resolve } from "node:path";

import { formatAgentContext, type AgentFormattedContext, type AgentFormattedNode } from "../context/agent-output.js";
import { agentOutputInvariantReason } from "../context/output-finalize.js";
import { exploreGodotContext } from "../context/explore.js";
import { getNodePayload } from "../context/node-payload.js";
import { isSqliteLockError } from "../db/errors.js";
import { createGraphDatabase } from "../db/index.js";
import { getProjectOverview } from "../graph/queries.js";
import {
  attachGraphQueryFreshness,
  getScanAwareGraphFreshness,
} from "../sync/freshness.js";
import { syncGodotProject, type SyncGodotProjectError, type SyncGodotProjectOk } from "../sync/index.js";
import { globalPendingFileTracker } from "../sync/watcher.js";
import { errorMessage, logMcpError } from "./logging.js";

const MCP_LOCK_RETRY_AFTER_MS = 1_000;
const MCP_SYNC_MESSAGE =
  "Synchronized graph index. Counts describe graph index changes, not Git status. Path lists are omitted to keep output compact.";

export interface GodotMcpToolDefinition {
  name: string;
  description: string;
  annotations?: {
    title?: string;
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
    idempotentHint?: boolean;
    openWorldHint?: boolean;
  };
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
      annotations: readOnlyAnnotations("Godot graph status"),
      inputSchema: projectPathSchema(),
    },
    {
      name: "godot_context",
      description:
        "Primary first call for Godot code, scene, resource, signal, node-path, flow, and edit-planning questions. Use terse identifier-heavy keyword queries, not natural-language task instructions.",
      annotations: readOnlyAnnotations("Godot graph context"),
      inputSchema: contextQuerySchema("query"),
    },
    {
      name: "godot_node",
      description: "Read indexed source for a Godot file, graph node id, or symbol without falling back to raw file reads.",
      annotations: readOnlyAnnotations("Godot indexed source"),
      inputSchema: nodeQuerySchema(),
    },
    {
      name: "godot_sync",
      description: "Synchronize changed Godot files into the graph index and return freshness metadata.",
      annotations: {
        title: "Godot graph sync",
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      inputSchema: projectPathSchema(),
    },
  ];
}

function readOnlyAnnotations(title: string): NonNullable<GodotMcpToolDefinition["annotations"]> {
  return {
    title,
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  };
}

export function callGodotMcpTool(
  name: string,
  args: Record<string, unknown> = {},
): GodotMcpToolResult {
  try {
    return callGodotMcpToolUnsafe(name, args);
  } catch (error) {
    if (isSqliteLockError(error)) {
      return jsonToolResult(lockedGraphPayload());
    }

    logMcpError("tool_failed", error, {
      tool: name,
    });
    return jsonToolResult(mcpToolErrorPayload(name, error));
  }
}

export function mcpToolErrorPayload(tool: string, error: unknown): Record<string, unknown> {
  const invariantReason = agentOutputInvariantReason(error);
  if (invariantReason) {
    return {
      ok: false,
      tool,
      error: "agent_output_invariant",
      reason: invariantReason,
    };
  }

  return {
    ok: false,
    tool,
    error: errorMessage(error),
  };
}

function lockedGraphPayload(): Record<string, unknown> {
  return {
    ok: false,
    reason: "locked",
    retryAfterMs: MCP_LOCK_RETRY_AFTER_MS,
    message: "Graph database is temporarily locked. Retry after the current sync operation finishes.",
    nextTools: [
      {
        tool: "godot_status",
        reason: "Check whether the graph is fresh after the lock clears.",
      },
      {
        tool: "godot_sync",
        reason: "Run if freshness is unknown or stale after the lock clears.",
      },
    ],
  };
}

function callGodotMcpToolUnsafe(
  name: string,
  args: Record<string, unknown> = {},
): GodotMcpToolResult {
  if (name === "godot_status") {
    return jsonToolResult(statusPayload(projectRootFromArgs(args)));
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
      const formattedContext = formatAgentContext(context, {
        maxChars: 4_800,
        maxNodes: 40,
        maxRelationships: 40,
        maxSnippets: 6,
      });
      return {
        ok: true,
        query,
        ...indexSummary(graph),
        context: formattedContext,
        nextTools: contextNextTools(formattedContext),
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
      return jsonToolResult(compactSyncErrorPayload(result));
    }

    globalPendingFileTracker.clearPending(projectRoot);
    const graph = createGraphDatabase(projectRoot);
    try {
      return jsonToolResult(
        attachGraphQueryFreshness(
          compactSyncPayload(result),
          getScanAwareGraphFreshness(projectRoot, graph),
        ),
      );
    } finally {
      graph.close();
    }
  }

  return jsonToolResult({
    ok: false,
    error: `Unknown tool: ${name}`,
  });
}

function contextNextTools(context: AgentFormattedContext): Array<Record<string, unknown>> {
  const nodeFollowups = concreteNodeFollowups(context);
  return [
    ...(nodeFollowups.length > 0
      ? nodeFollowups
      : [{
        tool: "godot_node",
        reason: "Use for indexed source reads when a specific file, symbol, or graph node needs source.",
      }]),
    {
      tool: "godot_status",
      reason: "Use to inspect freshness when context indicates stale or pending indexed files.",
    },
    {
      tool: "godot_sync",
      reason: "Use only when indexFresh=false or watcher catch-up is unavailable.",
    },
  ];
}

function concreteNodeFollowups(context: AgentFormattedContext): Array<Record<string, unknown>> {
  const seen = new Set<string>();
  const followups: Array<Record<string, unknown>> = [];

  for (const node of context.nodes) {
    const args = godotNodeArgsForContextNode(context, node);
    if (!args) {
      continue;
    }

    if (seen.has(args.file)) {
      continue;
    }

    seen.add(args.file);
    followups.push({
      tool: "godot_node",
      reason: "symbol" in args
        ? "Read source for the top indexed file and symbol from this context result."
        : "Read source for the top indexed file from this context result.",
      args,
    });

    if (followups.length >= 2) {
      break;
    }
  }

  return followups;
}

function godotNodeArgsForContextNode(
  context: AgentFormattedContext,
  node: AgentFormattedNode,
): Record<string, string> | null {
  if (!node.path) {
    return null;
  }

  const file = expandContextPath(context, node.path);
  if (!file) {
    return null;
  }

  if (node.kind === "resource" || node.kind === "scene" || node.kind === "file") {
    return { file };
  }

  return hasFileScopedSymbolSelector(node)
    ? { file, symbol: node.name }
    : null;
}

function hasFileScopedSymbolSelector(node: AgentFormattedNode): boolean {
  return [
    "script_class",
    "inner_class",
    "method",
    "property",
    "signal",
    "autoload",
  ].includes(node.kind) && node.name.length > 0;
}

function expandContextPath(context: AgentFormattedContext, pathRef: string): string | null {
  const compactPath = context.paths[pathRef];
  if (!compactPath) {
    return null;
  }

  for (const [prefixRef, prefixValue] of Object.entries(context.prefixes ?? {})) {
    if (compactPath.startsWith(`${prefixRef}/`)) {
      return compactPath.replace(`${prefixRef}/`, prefixValue);
    }
  }

  return compactPath;
}

function compactSyncPayload(result: SyncGodotProjectOk): Record<string, unknown> {
  const {
    added,
    modified,
    deleted,
    projectRoot: _projectRoot,
    databasePath: _databasePath,
    message: _message,
    parseErrors,
    ...rest
  } = result;
  return removeUndefined({
    ...rest,
    addedCount: added.length,
    modifiedCount: modified.length,
    deletedCount: deleted.length,
    parseErrorCount: parseErrors.length,
    parseErrors: parseErrors.length > 0 ? parseErrors.slice(0, 10) : undefined,
    parseErrorsOmitted: Math.max(0, parseErrors.length - 10) || undefined,
    changeListsOmitted: true,
    message: MCP_SYNC_MESSAGE,
  });
}

function compactSyncErrorPayload(result: SyncGodotProjectError): Record<string, unknown> {
  return removeUndefined({
    ok: false,
    reason: result.reason,
    message: compactErrorMessage(result),
    retryAfterMs: result.retryAfterMs,
    lockKind: result.lockKind,
  });
}

function compactErrorMessage(result: SyncGodotProjectError): string {
  if (result.reason === "missing_project_godot") {
    return "No project.godot found.";
  }
  return redactLocalPaths(result.message);
}

function redactLocalPaths(value: string): string {
  return value
    .replace(/\/(?:Users|Volumes|private|var|tmp)\/[^\s"'{}[\],)]+/g, "[local-path]")
    .replace(/[A-Za-z]:\\[^\s"'{}[\],)]+/g, "[local-path]");
}

function removeUndefined<T extends Record<string, unknown>>(value: T): T {
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
      [requiredField]: {
        type: "string",
        description:
          "Terse identifier-heavy keyword query. Prefer exact classes, methods, constants, fields, resource paths, file/path fragments, and domain nouns. Do not write natural-language task instructions like find, include paths, summarize, relevant for, or tell me.",
      },
      maxFiles: { type: "number", description: "Maximum number of top context files to emphasize." },
      includeCode: { type: "boolean", description: "Include bounded snippets in the context package." },
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
      includeNotes: { type: "boolean", description: "Include relationship notes around the selected node or file." },
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
      attachGraphQueryFreshness(callback(graph, projectRoot), getScanAwareGraphFreshness(projectRoot, graph)),
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
      pendingFileCount: 0,
      watcher: "disabled",
      lastSyncAt: null,
      lastSyncAtSource: "unknown",
      message: "No gdgraph index found. Run godot_sync first.",
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
        pendingFileCount: freshness.pendingFiles.length,
        indexFresh: false,
        message: "The gdgraph index exists but is empty. Run godot_sync before relying on graph answers.",
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
      pendingFileCount: freshness.pendingFiles.length,
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
