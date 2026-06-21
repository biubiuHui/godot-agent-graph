import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { createCliProgram } from "../../../src/cli/index.js";

const fixturesRoot = fileURLToPath(new URL("../../fixtures/godot", import.meta.url));
const tempRoots: string[] = [];

function copyFixture(name: string): string {
  const root = mkdtempSync(join(tmpdir(), `gdgraph-cli-${name}-`));
  tempRoots.push(root);
  cpSync(join(fixturesRoot, name), root, { recursive: true });
  return root;
}

async function runCli(args: string[]) {
  const output: string[] = [];
  const program = createCliProgram({
    version: "1.2.3",
    write: (text) => output.push(text),
  });

  await program.parseAsync(["node", "gdgraph", ...args]);

  return JSON.parse(output.join("")) as Record<string, unknown>;
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
});

describe("gdgraph CLI commands", () => {
  it("prints top-level help without a Commander stack trace", () => {
    const result = spawnSync(
      join(process.cwd(), "node_modules", ".bin", "tsx"),
      ["src/bin/gdgraph.ts", "--help"],
      {
        cwd: process.cwd(),
        encoding: "utf8",
      },
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Usage: gdgraph");
    expect(result.stderr).not.toContain("CommanderError");
    expect(result.stderr).not.toContain("helpDisplayed");
  });

  it("indexes a project with init and reports status", async () => {
    const root = copyFixture("minimal");

    expect(await runCli(["init", root])).toEqual(
      expect.objectContaining({
        ok: true,
        fileCount: 3,
      }),
    );

    expect(await runCli(["status", root])).toEqual(
      expect.objectContaining({
        initialized: true,
        fileCount: 3,
        project: expect.objectContaining({
          name: "MinimalFixture",
        }),
      }),
    );
  });

  it("indexes, lists files, and searches symbols", async () => {
    const root = copyFixture("minimal");
    await runCli(["index", root]);

    const files = await runCli(["files", root]);
    expect(files).toEqual({
      ok: true,
      files: [
        expect.objectContaining({ path: "res://fixture_main.tscn" }),
        expect.objectContaining({ path: "res://project.godot" }),
        expect.objectContaining({ path: "res://scripts/fixture_actor.gd" }),
      ],
    });

    const search = await runCli(["search", "FixtureActor", "--path", root]);
    expect(search).toEqual({
      ok: true,
      results: expect.arrayContaining([
        expect.objectContaining({
          id: "script:res://scripts/fixture_actor.gd",
          kind: "script_class",
        }),
      ]),
    });
  });

  it("rebuilds the graph through an explicit rebuild command", async () => {
    const root = copyFixture("minimal");

    expect(await runCli(["rebuild", root])).toEqual(
      expect.objectContaining({
        ok: true,
        fileCount: 3,
      }),
    );

    expect(await runCli(["search", "FixtureActor", "--path", root])).toEqual(
      expect.objectContaining({
        ok: true,
        results: expect.arrayContaining([
          expect.objectContaining({ id: "script:res://scripts/fixture_actor.gd" }),
        ]),
      }),
    );
  });

  it("cleans gdgraph storage without rebuilding", async () => {
    const root = copyFixture("minimal");
    await runCli(["index", root]);
    expect(existsSync(join(root, ".gdgraph", "graph.db"))).toBe(true);

    expect(await runCli(["clean", root])).toEqual({
      ok: true,
      projectRoot: root,
      graphDir: join(root, ".gdgraph"),
      removed: true,
    });
    expect(existsSync(join(root, ".gdgraph"))).toBe(false);

    expect(await runCli(["status", root])).toEqual(
      expect.objectContaining({
        ok: false,
        initialized: false,
      }),
    );
  });

  it("removes gdgraph storage through the uninit alias", async () => {
    const root = copyFixture("minimal");
    await runCli(["index", root]);
    expect(existsSync(join(root, ".gdgraph", "graph.db"))).toBe(true);

    expect(await runCli(["uninit", root])).toEqual({
      ok: true,
      projectRoot: root,
      graphDir: join(root, ".gdgraph"),
      removed: true,
    });
    expect(existsSync(join(root, ".gdgraph"))).toBe(false);
  });

  it("syncs added files and reports change counts", async () => {
    const root = copyFixture("minimal");
    await runCli(["index", root]);

    writeFileSync(
      join(root, "scripts", "sync_added.gd"),
      "extends Node\nclass_name SyncAdded\n",
    );

    expect(await runCli(["sync", root])).toEqual(
      expect.objectContaining({
        ok: true,
        addedCount: 1,
        modifiedCount: 0,
        deletedCount: 0,
        added: ["res://scripts/sync_added.gd"],
      }),
    );

    expect(await runCli(["search", "SyncAdded", "--path", root])).toEqual(
      expect.objectContaining({
        ok: true,
        results: expect.arrayContaining([
          expect.objectContaining({ id: "script:res://scripts/sync_added.gd" }),
        ]),
      }),
    );
  });

  it("marks status stale when a new Godot file exists before sync", async () => {
    const root = copyFixture("minimal");
    await runCli(["index", root]);
    writeFileSync(
      join(root, "scripts", "cli_profile_data.gd"),
      "extends Resource\nclass_name CliProfileData\n",
    );

    expect(await runCli(["status", root])).toEqual(
      expect.objectContaining({
        ok: true,
        initialized: true,
        indexFresh: false,
        pendingFiles: expect.arrayContaining([
          { path: "res://scripts/cli_profile_data.gd", indexing: false },
        ]),
      }),
    );
  });

  it("returns a clear JSON error for non-Godot projects", async () => {
    const root = mkdtempSync(join(tmpdir(), "gdgraph-cli-empty-"));
    tempRoots.push(root);

    expect(await runCli(["index", root])).toEqual({
      ok: false,
      projectRoot: root,
      reason: "missing_project_godot",
      message: `No project.godot found in ${root}`,
    });
  });

  it("installs Codex MCP configuration through the CLI", async () => {
    const root = copyFixture("minimal");
    const homeDir = mkdtempSync(join(tmpdir(), "gdgraph-cli-home-"));
    tempRoots.push(homeDir);

    const result = await runCli(["install", root, "--target", "codex", "--home", homeDir]);

    expect(result).toEqual(
      expect.objectContaining({
        ok: true,
        results: [
          expect.objectContaining({
            action: "installed",
            target: "codex",
          }),
        ],
      }),
    );
    expect(readFileSync(join(homeDir, ".codex", "config.toml"), "utf8")).toContain(
      `[mcp_servers.godot-agent-graph]`,
    );
  });

  it("uninstalls Claude MCP configuration through the CLI", async () => {
    const root = copyFixture("minimal");
    const homeDir = mkdtempSync(join(tmpdir(), "gdgraph-cli-home-"));
    tempRoots.push(homeDir);

    await runCli(["install", root, "--target", "claude", "--home", homeDir]);

    const result = await runCli(["uninstall", root, "--target", "claude", "--home", homeDir]);

    expect(result).toEqual(
      expect.objectContaining({
        ok: true,
        results: [
          expect.objectContaining({
            action: "removed",
            target: "claude",
          }),
        ],
      }),
    );
    expect(JSON.parse(readFileSync(join(root, ".mcp.json"), "utf8"))).toEqual({
      mcpServers: {},
    });
  });

  it("installs Cursor MCP configuration through the CLI", async () => {
    const root = copyFixture("minimal");
    const homeDir = mkdtempSync(join(tmpdir(), "gdgraph-cli-home-"));
    tempRoots.push(homeDir);

    const result = await runCli(["install", root, "--target", "cursor", "--home", homeDir]);

    expect(result).toEqual(
      expect.objectContaining({
        ok: true,
        results: [
          expect.objectContaining({
            action: "installed",
            target: "cursor",
          }),
        ],
      }),
    );
    expect(JSON.parse(readFileSync(join(root, ".cursor", "mcp.json"), "utf8"))).toEqual({
      mcpServers: {
        "godot-agent-graph": {
          type: "stdio",
          command: "gdgraph",
          args: ["serve", "--mcp", root],
        },
      },
    });
  });

  it("returns scene details and symbol matches", async () => {
    const root = copyFixture("minimal");
    await runCli(["index", root]);

    expect(await runCli(["scene", "res://fixture_main.tscn", "--path", root])).toEqual({
      ok: true,
      scene: expect.objectContaining({
        id: "scene:res://fixture_main.tscn",
        kind: "scene",
      }),
      nodes: [
        expect.objectContaining({ id: "scene_node:res://fixture_main.tscn:Main" }),
        expect.objectContaining({ id: "scene_node:res://fixture_main.tscn:FixtureActor" }),
      ],
    });

    expect(await runCli(["symbol", "FixtureActor", "--path", root])).toEqual({
      ok: true,
      results: expect.arrayContaining([
        expect.objectContaining({
          id: "script:res://scripts/fixture_actor.gd",
          kind: "script_class",
        }),
      ]),
    });
  });

  it("returns agent-first query contexts", async () => {
    const root = copyFixture("signals");
    await runCli(["index", root]);

    expect(await runCli(["explore", "SignalDemo", "--path", root])).toEqual(
      expect.objectContaining({
        ok: true,
        nodes: expect.arrayContaining([
          expect.objectContaining({ id: "script:res://scripts/signal_demo.gd" }),
        ]),
      }),
    );

    expect(await runCli(["callers", "damage", "--path", root])).toEqual(
      expect.objectContaining({
        ok: true,
        relationships: expect.any(Array),
      }),
    );

    expect(await runCli(["callees", "SignalDemo", "--path", root])).toEqual(
      expect.objectContaining({
        ok: true,
        nodes: expect.any(Array),
      }),
    );

    expect(await runCli(["impact", "health_depleted", "--path", root])).toEqual(
      expect.objectContaining({
        ok: true,
        recommendedCheckFiles: expect.arrayContaining(["res://scripts/signal_demo.gd"]),
      }),
    );
  });
});
