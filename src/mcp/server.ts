import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { resolve } from "node:path";

import { getMcpInstructions } from "./instructions.js";
import { logMcpError, type McpLogWriter } from "./logging.js";
import { callGodotMcpTool, listGodotMcpTools } from "./tools.js";
import { syncGodotProject, type SyncGodotProjectResult } from "../sync/index.js";
import { globalPendingFileTracker, watchGodotProject } from "../sync/watcher.js";

const CONTEXT_QUERY_DESCRIPTION =
  "Terse identifier-heavy keyword query. Prefer exact classes, methods, constants, fields, resource paths, file/path fragments, and domain nouns. Do not write natural-language task instructions like find, include paths, summarize, relevant for, or tell me.";

export interface CreateGodotMcpServerOptions {
  projectRoot?: string;
}

export interface CreatedGodotMcpServer {
  server: McpServer;
  toolNames: string[];
}

export interface ServeGodotMcpOptions {
  projectRoot?: string;
}

export interface CreateWatcherSyncHandlerOptions {
  projectRoot: string;
  syncProject?: (projectRoot: string) => SyncGodotProjectResult;
  clearPending?: (projectRoot: string) => void;
  logError?: McpLogWriter;
}

export function createGodotMcpServer(
  options: CreateGodotMcpServerOptions = {},
): CreatedGodotMcpServer {
  const projectRoot = resolve(options.projectRoot ?? ".");
  const server = new McpServer(
    {
      name: "godot-agent-graph",
      version: "0.1.0",
    },
    {
      instructions: getMcpInstructions(),
    },
  );

  for (const tool of listGodotMcpTools()) {
    server.registerTool(
      tool.name,
      {
        description: tool.description,
        inputSchema: inputSchemaForTool(tool.name),
        annotations: tool.annotations,
      },
      async (args) =>
        callGodotMcpTool(tool.name, {
          projectPath: projectRoot,
          ...(args as Record<string, unknown>),
        }),
    );
  }

  return {
    server,
    toolNames: listGodotMcpTools().map((tool) => tool.name),
  };
}

export async function serveGodotMcp(options: ServeGodotMcpOptions = {}): Promise<void> {
  const projectRoot = resolve(options.projectRoot ?? ".");
  const syncResult = syncGodotProject(projectRoot);
  if (syncResult.ok) {
    globalPendingFileTracker.clearPending(projectRoot);
  } else {
    logMcpError("startup_sync_failed", new Error("Startup sync failed."), {
      reason: syncResult.reason,
    });
  }

  const watcher = syncResult.ok
    ? watchGodotProject(projectRoot, {
        onSync: createWatcherSyncHandler({ projectRoot }),
      })
    : null;

  try {
    const { server } = createGodotMcpServer({ projectRoot });
    await server.connect(new StdioServerTransport());
  } catch (error) {
    watcher?.close();
    throw error;
  }
}

export function createWatcherSyncHandler(
  options: CreateWatcherSyncHandlerOptions,
): () => void {
  const syncProject = options.syncProject ?? syncGodotProject;
  const clearPending =
    options.clearPending ?? ((projectRoot) => globalPendingFileTracker.clearPending(projectRoot));

  return () => {
    try {
      const result = syncProject(options.projectRoot);
      if (result.ok) {
        clearPending(options.projectRoot);
        return;
      }

      logMcpError("watcher_sync_failed", new Error("Watcher sync failed."), {
        reason: result.reason,
      }, options.logError);
    } catch (error) {
      logMcpError("watcher_sync_failed", error, {
      }, options.logError);
    }
  };
}

export function inputSchemaForTool(toolName: string): Record<string, z.ZodTypeAny> {
  if (toolName === "godot_context") {
    return {
      projectPath: z.string().optional(),
      query: z.string().describe(CONTEXT_QUERY_DESCRIPTION),
      maxFiles: z.number().describe("Maximum number of top context files to emphasize.").optional(),
      includeCode: z.boolean().describe("Include bounded snippets in the context package.").optional(),
    };
  }

  if (toolName === "godot_node") {
    return {
      projectPath: z.string().optional(),
      id: z.string().optional(),
      symbol: z.string().optional(),
      file: z.string().optional(),
      offset: z.number().optional(),
      limit: z.number().optional(),
      includeCode: z.boolean().optional(),
      includeNotes: z.boolean().describe("Include relationship notes around the selected node or file.").optional(),
      symbolsOnly: z.boolean().optional(),
    };
  }

  return {
    projectPath: z.string().optional(),
  };
}
