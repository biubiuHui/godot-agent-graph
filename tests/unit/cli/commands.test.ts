import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

function expectNoLocalPathFields(payload: Record<string, unknown>, root: string): void {
  const text = JSON.stringify(payload);
  expect(payload).not.toHaveProperty("projectRoot");
  expect(payload).not.toHaveProperty("dbPath");
  expect(payload).not.toHaveProperty("databasePath");
  expect(payload).not.toHaveProperty("graphDir");
  expect(text).not.toContain(root);
}

async function expectUnknownCommand(commandName: string): Promise<void> {
  const program = createCliProgram({
    version: "1.2.3",
    write: () => {},
  });

  await expect(program.parseAsync(["node", "gdgraph", commandName])).rejects.toThrow(
    "unknown command",
  );
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
});

describe("gdgraph CLI commands", () => {
  it("prints final top-level help without legacy commands", async () => {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const program = createCliProgram({
      version: "1.2.3",
      write: () => {},
    });
    program.configureOutput({
      writeOut: (text) => stdout.push(text),
      writeErr: (text) => stderr.push(text),
    });

    await expect(program.parseAsync(["node", "gdgraph", "--help"])).rejects.toMatchObject({
      code: "commander.helpDisplayed",
      exitCode: 0,
    });

    const helpText = stdout.join("");
    const errorText = stderr.join("");
    expect(helpText).toContain("Usage: gdgraph");
    for (const commandName of ["sync", "status", "clean", "context", "node", "serve", "install", "uninstall"]) {
      expect(helpText).toMatch(new RegExp(`^  ${commandName}\\b`, "m"));
    }
    for (const commandName of [
      "init",
      "index",
      "build",
      "rebuild",
      "uninit",
      "files",
      "search",
      "scene",
      "symbol",
      "explore",
      "callers",
      "callees",
      "impact",
    ]) {
      expect(helpText).not.toMatch(new RegExp(`^  ${commandName}\\b`, "m"));
    }
    expect(errorText).not.toContain("CommanderError");
    expect(errorText).not.toContain("helpDisplayed");
  });

  it("syncs a fresh project and reports status", async () => {
    const root = copyFixture("minimal");

    const sync = await runCli(["sync", root]);
    expect(sync).toEqual(
      expect.objectContaining({
        ok: true,
        fileCount: 3,
        addedCount: 3,
        modifiedCount: 0,
        deletedCount: 0,
        parseErrorCount: 0,
        parseErrorScope: "gdgraph_static_parse",
        compilerChecked: false,
        changeListsOmitted: true,
      }),
    );
    expectNoLocalPathFields(sync, root);

    const status = await runCli(["status", root]);
    expect(status).toEqual(
      expect.objectContaining({
        initialized: true,
        fileCount: 3,
        pendingFileCount: 0,
      }),
    );
    expect(status).not.toHaveProperty("project");
    expect(status).not.toHaveProperty("freshness");
    expectNoLocalPathFields(status, root);
  });

  it("returns context packages through the final context command", async () => {
    const root = copyFixture("minimal");
    await runCli(["sync", root]);

    const context = await runCli(["context", "FixtureActor", "--path", root, "--code"]);

    expect(context).toEqual(
      expect.objectContaining({
        ok: true,
        query: "FixtureActor",
        indexFresh: true,
        pendingFileCount: 0,
        context: expect.objectContaining({
          nodes: expect.arrayContaining([
            expect.objectContaining({
              id: expect.stringMatching(/^n\d+$/),
              kind: "script_class",
              path: "p1",
            }),
          ]),
          snippets: expect.arrayContaining([
            expect.objectContaining({
              text: expect.stringContaining("class_name FixtureActor"),
            }),
          ]),
        }),
      }),
    );
    expect(context).not.toHaveProperty("project");
    expect(context).not.toHaveProperty("freshness");
    expectNoLocalPathFields(context, root);
  });

  it("reads indexed source through the final node command", async () => {
    const root = copyFixture("minimal");
    await runCli(["sync", root]);

    expect(
      await runCli(["node", "--path", root, "--file", "res://scripts/fixture_actor.gd", "--limit", "4"]),
    ).toEqual(
      expect.objectContaining({
        ok: true,
        paths: expect.objectContaining({
          p1: "res://scripts/fixture_actor.gd",
        }),
        source: expect.objectContaining({
          path: "p1",
          text: expect.stringContaining("class_name FixtureActor"),
        }),
      }),
    );

    const symbolWithoutCode = await runCli(["node", "--path", root, "--symbol", "FixtureActor", "--no-code"]);
    expect(symbolWithoutCode).toEqual(
      expect.objectContaining({
        ok: true,
        target: expect.objectContaining({
          kind: "script_class",
          id: expect.stringMatching(/^n\d+$/),
          path: "p1",
        }),
      }),
    );
    expect(symbolWithoutCode).not.toHaveProperty("source");

    const symbolsOnly = await runCli([
      "node",
      "--path",
      root,
      "--id",
      "script:res://scripts/fixture_actor.gd",
      "--symbols-only",
    ]);
    expect(symbolsOnly).toEqual(
      expect.objectContaining({
        ok: true,
        symbols: expect.arrayContaining([
          expect.objectContaining({ kind: "method", path: "p1" }),
        ]),
      }),
    );
    expect(symbolsOnly).not.toHaveProperty("source");
  });

  it("cleans gdgraph storage", async () => {
    const root = copyFixture("minimal");
    await runCli(["sync", root]);
    expect(existsSync(join(root, ".gdgraph", "graph.db"))).toBe(true);

    const clean = await runCli(["clean", root]);
    expect(clean).toEqual({
      ok: true,
      removed: true,
    });
    expectNoLocalPathFields(clean, root);
    expect(existsSync(join(root, ".gdgraph"))).toBe(false);
  });

  it("rebuilds gdgraph storage through sync --rebuild", async () => {
    const root = copyFixture("minimal");
    await runCli(["sync", root]);
    const sentinelPath = join(root, ".gdgraph", "stale-marker.txt");
    writeFileSync(sentinelPath, "old index data\n");

    const rebuild = await runCli(["sync", root, "--rebuild"]);
    expect(rebuild).toEqual(
      expect.objectContaining({
        ok: true,
        rebuilt: true,
        fileCount: 3,
        addedCount: 3,
        modifiedCount: 0,
        deletedCount: 0,
        parseErrorCount: 0,
        changeListsOmitted: true,
        message: expect.stringContaining("Rebuilt graph index from scratch"),
      }),
    );
    expectNoLocalPathFields(rebuild, root);
    expect(rebuild).not.toHaveProperty("added");
    expect(rebuild).not.toHaveProperty("modified");
    expect(rebuild).not.toHaveProperty("deleted");
    expect(existsSync(sentinelPath)).toBe(false);
    expect(existsSync(join(root, ".gdgraph", "graph.db"))).toBe(true);
  });

  it("syncs added files and makes them visible through context", async () => {
    const root = copyFixture("minimal");
    await runCli(["sync", root]);

    writeFileSync(
      join(root, "scripts", "sync_added.gd"),
      "extends Node\nclass_name SyncAdded\n",
    );

    const sync = await runCli(["sync", root]);
    expect(sync).toEqual(
      expect.objectContaining({
        ok: true,
        addedCount: 1,
        modifiedCount: 0,
        deletedCount: 0,
        parseErrorCount: 0,
        changeListsOmitted: true,
        message: expect.stringContaining("Synchronized graph index"),
      }),
    );
    expectNoLocalPathFields(sync, root);
    expect(sync).not.toHaveProperty("added");
    expect(sync).not.toHaveProperty("modified");
    expect(sync).not.toHaveProperty("deleted");

    expect(await runCli(["context", "SyncAdded", "--path", root])).toEqual(
      expect.objectContaining({
        ok: true,
        context: expect.objectContaining({
          nodes: expect.arrayContaining([
            expect.objectContaining({
              kind: "script_class",
              name: "SyncAdded",
              path: "p1",
            }),
          ]),
        }),
      }),
    );
  });

  it("marks status stale when a new Godot file exists before sync", async () => {
    const root = copyFixture("minimal");
    await runCli(["sync", root]);
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

    const response = await runCli(["sync", root]);
    expect(response).toEqual({
      ok: false,
      reason: "missing_project_godot",
      message: "No project.godot found.",
    });
    expectNoLocalPathFields(response, root);
  });

  it("does not clean storage on sync --rebuild when the path is not a Godot project", async () => {
    const root = mkdtempSync(join(tmpdir(), "gdgraph-cli-empty-"));
    tempRoots.push(root);
    const sentinelPath = join(root, ".gdgraph", "external-data.txt");
    mkdirSync(join(root, ".gdgraph"));
    writeFileSync(sentinelPath, "keep me\n");

    const response = await runCli(["sync", root, "--rebuild"]);
    expect(response).toEqual({
      ok: false,
      reason: "missing_project_godot",
      message: "No project.godot found.",
      rebuilt: false,
    });
    expectNoLocalPathFields(response, root);
    expect(existsSync(sentinelPath)).toBe(true);
  });

  it("rejects removed legacy commands", async () => {
    for (const commandName of [
      "init",
      "index",
      "build",
      "rebuild",
      "uninit",
      "files",
      "search",
      "scene",
      "symbol",
      "explore",
      "callers",
      "callees",
      "impact",
    ]) {
      await expectUnknownCommand(commandName);
    }
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
    expect(existsSync(join(root, ".agents", "skills", "godot-graph-navigation", "SKILL.md"))).toBe(false);
  });

  it("optionally installs the Codex global skill through the CLI", async () => {
    const root = copyFixture("minimal");
    const homeDir = mkdtempSync(join(tmpdir(), "gdgraph-cli-home-"));
    tempRoots.push(homeDir);

    const result = await runCli(["install", root, "--target", "codex", "--home", homeDir, "--with-skill"]);

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
    expect(
      readFileSync(join(homeDir, ".codex", "skills", "godot-graph-navigation", "SKILL.md"), "utf8"),
    ).toContain("name: godot-graph-navigation");
    expect(
      readFileSync(join(homeDir, ".codex", "skills", "godot-graph-navigation", "agents", "openai.yaml"), "utf8"),
    ).toContain('display_name: "Godot Graph Navigation"');
    expect(existsSync(join(root, ".agents", "skills", "godot-graph-navigation", "SKILL.md"))).toBe(false);
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
});
