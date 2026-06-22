import { describe, expect, it } from "vitest";

import { createCliProgram } from "../../../src/cli/index.js";
import {
  createGodotMcpServer,
  createWatcherSyncHandler,
  inputSchemaForTool,
} from "../../../src/mcp/server.js";
import { listGodotMcpTools } from "../../../src/mcp/tools.js";

describe("MCP server wiring", () => {
  it("constructs a server with baseline tool names", () => {
    const created = createGodotMcpServer({ projectRoot: "/tmp/example" });

    expect(created.toolNames).toEqual([
      "godot_status",
      "godot_context",
      "godot_node",
      "godot_sync",
    ]);
    expect(created.server).toBeDefined();
  });

  it("exposes godot_node selectors through the server schema", () => {
    expect(Object.keys(inputSchemaForTool("godot_node"))).toEqual(expect.arrayContaining([
      "projectPath",
      "id",
      "symbol",
      "file",
      "offset",
      "limit",
      "includeCode",
      "symbolsOnly",
    ]));
  });

  it("keeps default server schemas aligned with tool definitions", () => {
    for (const tool of listGodotMcpTools()) {
      expect(Object.keys(inputSchemaForTool(tool.name)).sort()).toEqual(
        Object.keys(tool.inputSchema.properties).sort(),
      );
    }
  });

  it("delegates gdgraph serve --mcp to the supplied serve hook", async () => {
    const calls: string[] = [];
    const program = createCliProgram({
      version: "1.2.3",
      write: () => {},
      serveMcp: async ({ projectRoot }) => {
        calls.push(projectRoot ?? "");
      },
    });

    await program.parseAsync(["node", "gdgraph", "serve", "--mcp", "/tmp/project"]);

    expect(calls).toEqual(["/tmp/project"]);
  });

  it("logs watcher sync failures without throwing", () => {
    const messages: string[] = [];
    const handler = createWatcherSyncHandler({
      projectRoot: "/tmp/project",
      syncProject: () => {
        throw new Error("sync exploded");
      },
      logError: (message) => messages.push(message),
    });

    expect(() => handler()).not.toThrow();
    expect(messages.join("\n")).toContain("watcher_sync_failed");
    expect(messages.join("\n")).toContain("/tmp/project");
    expect(messages.join("\n")).toContain("sync exploded");
  });
});
