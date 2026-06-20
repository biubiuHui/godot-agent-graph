import { describe, expect, it } from "vitest";

import { createCliProgram } from "../../../src/cli/index.js";
import { createGodotMcpServer } from "../../../src/mcp/server.js";

describe("MCP server wiring", () => {
  it("constructs a server with baseline tool names", () => {
    const created = createGodotMcpServer({ projectRoot: "/tmp/example" });

    expect(created.toolNames).toEqual([
      "godot_status",
      "godot_project_map",
      "godot_sync",
      "godot_search",
      "godot_scene",
      "godot_explore",
      "godot_symbol",
      "godot_callers",
      "godot_callees",
      "godot_impact",
    ]);
    expect(created.server).toBeDefined();
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
});
