import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createCliProgram } from "../../../src/cli/index.js";
import {
  createGodotMcpServer,
  createWatcherSyncHandler,
  inputSchemaForTool,
} from "../../../src/mcp/server.js";
import { listGodotMcpTools } from "../../../src/mcp/tools.js";

const tempRoots: string[] = [];

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
});

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
      "includeNotes",
      "symbolsOnly",
    ]));
  });

  it("keeps godot_node listed schema aligned with handler options", () => {
    const nodeTool = listGodotMcpTools().find((tool) => tool.name === "godot_node");

    expect(Object.keys(nodeTool?.inputSchema.properties ?? {})).toEqual(expect.arrayContaining([
      "projectPath",
      "id",
      "symbol",
      "file",
      "offset",
      "limit",
      "includeCode",
      "includeNotes",
      "symbolsOnly",
    ]));
  });

  it("exposes godot_context query options through the server schema", () => {
    const schema = inputSchemaForTool("godot_context");

    expect(Object.keys(schema)).toEqual(expect.arrayContaining([
      "projectPath",
      "query",
      "maxFiles",
      "includeCode",
    ]));
    expect(schema.query.description).toContain("identifier-heavy keyword");
  });

  it("does not expose removed legacy schemas", () => {
    expect(Object.keys(inputSchemaForTool("godot_search"))).toEqual(["projectPath"]);
    expect(Object.keys(inputSchemaForTool("godot_impact"))).toEqual(["projectPath"]);
  });

  it("keeps default server schemas aligned with tool definitions", () => {
    for (const tool of listGodotMcpTools()) {
      expect(Object.keys(inputSchemaForTool(tool.name)).sort()).toEqual(
        Object.keys(tool.inputSchema.properties).sort(),
      );
    }
  });

  it("marks query tools as read-only and sync as non-destructive", () => {
    const tools = new Map(listGodotMcpTools().map((tool) => [tool.name, tool]));

    expect(tools.get("godot_status")?.annotations).toEqual(
      expect.objectContaining({ readOnlyHint: true, destructiveHint: false }),
    );
    expect(tools.get("godot_context")?.annotations).toEqual(
      expect.objectContaining({ readOnlyHint: true, destructiveHint: false }),
    );
    expect(tools.get("godot_node")?.annotations).toEqual(
      expect.objectContaining({ readOnlyHint: true, destructiveHint: false }),
    );
    expect(tools.get("godot_sync")?.annotations).toEqual(
      expect.objectContaining({
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
      }),
    );
  });

  it("delegates gdgraph serve --mcp to the supplied serve hook", async () => {
    const calls: string[] = [];
    const projectRoot = mkdtempSync(join(tmpdir(), "gdgraph-serve-hook-"));
    tempRoots.push(projectRoot);
    writeFileSync(join(projectRoot, "project.godot"), "[application]\nconfig/name=\"ServeHook\"\n");
    const program = createCliProgram({
      version: "1.2.3",
      write: () => {},
      serveMcp: async ({ projectRoot }) => {
        calls.push(projectRoot ?? "");
      },
    });

    await program.parseAsync(["node", "gdgraph", "serve", "--mcp", projectRoot]);

    expect(calls).toEqual([projectRoot]);
    expect(existsSync(join(projectRoot, ".gdgraph"))).toBe(false);
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
    expect(messages.join("\n")).toContain("sync exploded");
  });
});
