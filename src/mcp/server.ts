import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { resolve } from "node:path";

import { getMcpInstructions } from "./instructions.js";
import { callGodotMcpTool, listGodotMcpTools } from "./tools.js";
import { syncGodotProject } from "../sync/index.js";
import { globalPendingFileTracker, watchGodotProject } from "../sync/watcher.js";

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
  }

  const watcher = syncResult.ok
    ? watchGodotProject(projectRoot, {
        onSync: () => {
          const result = syncGodotProject(projectRoot);
          if (result.ok) {
            globalPendingFileTracker.clearPending(projectRoot);
          }
        },
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

function inputSchemaForTool(toolName: string): Record<string, z.ZodTypeAny> {
  if (toolName === "godot_search") {
    return {
      projectPath: z.string().optional(),
      query: z.string(),
      limit: z.number().optional(),
    };
  }

  if (toolName === "godot_scene") {
    return {
      projectPath: z.string().optional(),
      scenePath: z.string(),
    };
  }

  if (toolName === "godot_explore") {
    return {
      projectPath: z.string().optional(),
      query: z.string(),
      maxFiles: z.number().optional(),
      includeCode: z.boolean().optional(),
    };
  }

  if (toolName === "godot_symbol" || toolName === "godot_callers" || toolName === "godot_callees") {
    return {
      projectPath: z.string().optional(),
      symbol: z.string(),
      maxFiles: z.number().optional(),
      includeCode: z.boolean().optional(),
    };
  }

  if (toolName === "godot_impact") {
    return {
      projectPath: z.string().optional(),
      target: z.string(),
    };
  }

  return {
    projectPath: z.string().optional(),
  };
}
