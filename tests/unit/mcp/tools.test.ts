import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { createGraphDatabase } from "../../../src/db/index.js";
import { indexGodotProject } from "../../../src/indexer/indexer.js";
import { AgentOutputInvariantError } from "../../../src/context/output-finalize.js";
import { getMcpInstructions } from "../../../src/mcp/instructions.js";
import { callGodotMcpTool, listGodotMcpTools, mcpToolErrorPayload } from "../../../src/mcp/tools.js";
import { globalPendingFileTracker } from "../../../src/sync/watcher.js";

const fixturesRoot = fileURLToPath(new URL("../../fixtures/godot", import.meta.url));
const tempRoots: string[] = [];

function copyFixture(name: string): string {
  const root = mkdtempSync(join(tmpdir(), `gdgraph-mcp-${name}-`));
  tempRoots.push(root);
  cpSync(join(fixturesRoot, name), root, { recursive: true });
  return root;
}

function parseTextContent(result: { content: Array<{ type: string; text?: string }> }) {
  const text = result.content.find((item) => item.type === "text")?.text ?? "{}";
  return JSON.parse(text) as Record<string, unknown>;
}

function textContent(result: { content: Array<{ type: string; text?: string }> }): string {
  return result.content.find((item) => item.type === "text")?.text ?? "";
}

function countSubstring(text: string, value: string): number {
  return text.split(value).length - 1;
}

function noteEntries(notes: Record<string, unknown>): Array<Record<string, unknown>> {
  return ["callers", "callees", "dependents", "dependencies"].flatMap((key) =>
    (notes[key] as Array<Record<string, unknown>> | undefined) ?? [],
  );
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    globalPendingFileTracker.clearPending(root);
    rmSync(root, { force: true, recursive: true });
  }
});

describe("MCP Godot tools", () => {
  it("maps output invariant errors to compact MCP payloads", () => {
    const payload = mcpToolErrorPayload(
      "godot_context",
      new AgentOutputInvariantError("orphan_context_path"),
    );
    const serialized = JSON.stringify(payload);

    expect(payload).toEqual({
      ok: false,
      tool: "godot_context",
      error: "agent_output_invariant",
      reason: "orphan_context_path",
    });
    expect(serialized).not.toContain("Agent output invariant failed");
    expect(serialized).not.toContain("filePath");
    expect(serialized).not.toContain("graphId");
  });

  it("provides graph-first agent instructions", () => {
    const instructions = getMcpInstructions();

    expect(instructions).toContain("godot_context");
    expect(instructions).toContain("godot_node");
    expect(instructions).toContain("graph-native source read");
    expect(instructions).toContain("includeNotes=false");
    expect(instructions).toContain("Do not rebuild indexed Godot structure with broad grep/read");
    expect(instructions).toContain("raw Read only for unindexed files or files listed as stale");
    expect(instructions).toContain("indexFresh");
    expect(instructions).toContain("lastSyncAtSource");
    expect(instructions).toContain("godot_sync");
    expect(instructions).toContain("truncated=true");
    expect(instructions).toContain("notes.omitted");
    expect(instructions).toContain("strategy");
    expect(instructions).toContain("completeness");
    expect(instructions).toContain("complete=true");
    expect(instructions).toContain("notes.complete");
    expect(instructions).toContain("gdgraph clean");
    expect(instructions).toContain("gdgraph sync");
    expect(instructions).toContain("breaking index");
    expect(instructions).toContain("For .tres resource queries");
    expect(instructions).toContain("constants, enums, signal names, resource paths, or string protocols");
    expect(instructions).toContain("terse identifier-heavy keyword queries");
    expect(instructions).toContain("Do not write natural-language task instructions");
    expect(instructions.split("\n").length).toBeLessThanOrEqual(22);
    for (const debugOnlyTerm of ["graphFrom", "graphTo", "filePath", "databasePath", "projectRoot"]) {
      expect(instructions).not.toContain(debugOnlyTerm);
    }
    for (const localPathTerm of [
      "/" + "Users" + "/",
      "/" + "Volumes" + "/",
      "/" + "private" + "/",
      "/" + "var/folders" + "/",
    ]) {
      expect(instructions).not.toContain(localPathTerm);
    }
    expect(instructions).not.toContain("godot_project_map");
    expect(instructions).not.toContain("For focused follow-up, use godot_search and godot_scene");
  });

  it("lists the default agent-native tools", () => {
    const tools = listGodotMcpTools();
    expect(tools.map((tool) => tool.name)).toEqual([
      "godot_status",
      "godot_context",
      "godot_node",
      "godot_sync",
    ]);
    expect(tools.find((tool) => tool.name === "godot_context")?.description).toContain(
      "Primary",
    );
    expect(tools.find((tool) => tool.name === "godot_context")?.description).toContain(
      "identifier-heavy keyword",
    );
    expect(
      tools.find((tool) => tool.name === "godot_context")?.inputSchema.properties.query,
    ).toEqual(
      expect.objectContaining({
        description: expect.stringContaining("Do not write natural-language task instructions"),
      }),
    );
    expect(tools.find((tool) => tool.name === "godot_node")?.description).toContain(
      "indexed source",
    );
  });

  it("rejects removed legacy MCP tools", () => {
    const legacyTools = [
      "godot_search",
      "godot_scene",
      "godot_explore",
      "godot_symbol",
      "godot_callers",
      "godot_callees",
      "godot_impact",
      "godot_project_map",
    ];

    for (const toolName of legacyTools) {
      expect(parseTextContent(callGodotMcpTool(toolName, { projectPath: "." }))).toEqual(
        expect.objectContaining({
          ok: false,
          error: `Unknown tool: ${toolName}`,
        }),
      );
    }
  });

  it("syncs through MCP and reports freshness metadata", () => {
    const root = copyFixture("minimal");
    const indexResult = indexGodotProject(root);
    expect(indexResult.ok).toBe(true);

    writeFileSync(
      join(root, "scripts", "mcp_added.gd"),
      "extends Node\nclass_name McpAdded\n",
    );

    globalPendingFileTracker.markPending(root, "res://scripts/mcp_added.gd");

    const staleContextText = textContent(
      callGodotMcpTool("godot_context", { projectPath: root, query: "FixtureActor" }),
    );
    const staleContext = JSON.parse(staleContextText) as Record<string, unknown>;
    expect(staleContext).toEqual(
      expect.objectContaining({
        ok: true,
        indexFresh: false,
        stale: true,
        staleFileCount: 1,
        staleFilesOmitted: 1,
        pendingFileCount: 1,
      }),
    );
    expect(staleContext).not.toHaveProperty("pendingFiles");
    expect(staleContext).not.toHaveProperty("freshness");
    expect(staleContext).not.toHaveProperty("staleFiles");
    expect(countSubstring(staleContextText, "res://scripts/mcp_added.gd")).toBe(0);

    expect(
      parseTextContent(callGodotMcpTool("godot_context", { projectPath: root, query: "NoSuchSymbol" })),
    ).toEqual(
      expect.objectContaining({
        ok: true,
        indexFresh: false,
        stale: true,
      }),
    );

    const sync = parseTextContent(callGodotMcpTool("godot_sync", { projectPath: root }));
    expect(sync).toEqual(
      expect.objectContaining({
        ok: true,
        addedCount: 1,
        changeListsOmitted: true,
        changeScope: "graph_index",
        parseErrorScope: "gdgraph_static_parse",
        compilerChecked: false,
        message: expect.stringContaining("graph index"),
        indexFresh: true,
        pendingFileCount: 0,
        lastSyncAt: expect.any(Number),
        lastSyncAtSource: "sync",
      }),
    );
    expect(sync).not.toHaveProperty("projectRoot");
    expect(sync).not.toHaveProperty("databasePath");
    expect(sync).not.toHaveProperty("pendingFiles");
    expect(sync).not.toHaveProperty("freshness");
    expect(sync).not.toHaveProperty("added");
    expect(sync).not.toHaveProperty("modified");
    expect(sync).not.toHaveProperty("deleted");
  });

  it("returns primary Godot context with next tool guidance", () => {
    const root = copyFixture("minimal");
    indexGodotProject(root);

    const response = parseTextContent(
      callGodotMcpTool("godot_context", {
        projectPath: root,
        query: "FixtureActor",
        includeCode: false,
      }),
    );

    expect(response).toEqual(
      expect.objectContaining({
        ok: true,
        query: "FixtureActor",
        fileCount: 3,
        nodeCount: expect.any(Number),
        edgeCount: expect.any(Number),
        indexEmpty: false,
        indexFresh: true,
        pendingFileCount: 0,
        watcher: "disabled",
        lastSyncAt: expect.any(Number),
        lastSyncAtSource: "index",
        context: expect.objectContaining({
          query: "FixtureActor",
          paths: expect.objectContaining({
            p1: "res://scripts/fixture_actor.gd",
          }),
          nodes: expect.arrayContaining([
            expect.objectContaining({
              id: expect.stringMatching(/^n\d+$/),
              path: "p1",
            }),
          ]),
          entryPoints: expect.arrayContaining([expect.stringMatching(/^n\d+$/)]),
          relationships: expect.arrayContaining([
            expect.objectContaining({
              from: expect.stringMatching(/^n\d+$/),
              kind: "attaches_script",
              to: expect.stringMatching(/^n\d+$/),
            }),
          ]),
          snippets: [],
          truncated: false,
          omitted: expect.objectContaining({
            nodes: 0,
            relationships: 0,
            snippets: 0,
          }),
          budget: expect.objectContaining({
            maxChars: expect.any(Number),
            estimatedChars: expect.any(Number),
          }),
        }),
        nextTools: expect.arrayContaining([
          expect.objectContaining({
            tool: "godot_node",
            reason: expect.stringContaining("source"),
            args: {
              file: "res://scripts/fixture_actor.gd",
              symbol: "FixtureActor",
            },
          }),
          expect.objectContaining({
            tool: "godot_status",
            reason: expect.stringContaining("freshness"),
          }),
        ]),
      }),
    );
    expect(response.context as Record<string, unknown>).not.toHaveProperty("files");
    const nodes = (response.context as Record<string, unknown>).nodes as Array<Record<string, unknown>>;
    expect(nodes.every((node) => !("graphId" in node))).toBe(true);
  });

  it("returns structured retry guidance when the graph database is locked", () => {
    const root = copyFixture("minimal");
    indexGodotProject(root);
    const locker = createGraphDatabase(root);

    try {
      locker.sqlite.exec("BEGIN EXCLUSIVE");
      const response = parseTextContent(
        callGodotMcpTool("godot_context", {
          projectPath: root,
          query: "FixtureActor",
        }),
      );

      expect(response).toEqual(
        expect.objectContaining({
          ok: false,
          reason: "locked",
          retryAfterMs: expect.any(Number),
          nextTools: expect.arrayContaining([
            expect.objectContaining({ tool: "godot_status" }),
            expect.objectContaining({ tool: "godot_sync" }),
          ]),
        }),
      );
    } finally {
      locker.sqlite.exec("ROLLBACK");
      locker.close();
    }
  });

  it("uses godot_context paths and node names as godot_node selectors", () => {
    const root = copyFixture("minimal");
    indexGodotProject(root);

    const contextResponse = parseTextContent(
      callGodotMcpTool("godot_context", {
        projectPath: root,
        query: "FixtureActor",
        includeCode: false,
      }),
    );
    const context = contextResponse.context as Record<string, unknown>;
    const nodes = context.nodes as Array<Record<string, unknown>>;
    const paths = context.paths as Record<string, string>;
    const actorNode = nodes.find((node) => node.kind === "script_class");
    expect(actorNode).toEqual(expect.objectContaining({
      id: expect.stringMatching(/^n\d+$/),
      name: "FixtureActor",
      path: "p1",
    }));
    expect(actorNode).not.toHaveProperty("graphId");

    expect(
      parseTextContent(callGodotMcpTool("godot_node", {
        projectPath: root,
        file: paths[actorNode?.path as string],
        symbol: actorNode?.name,
      })),
    ).toEqual(
      expect.objectContaining({
        ok: true,
        paths: expect.objectContaining({
          p1: "res://scripts/fixture_actor.gd",
        }),
        target: expect.objectContaining({
          id: expect.stringMatching(/^n\d+$/),
          kind: "script_class",
          path: "p1",
        }),
        source: expect.objectContaining({
          path: "p1",
          text: expect.stringContaining("class_name FixtureActor"),
        }),
      }),
    );
  });

  it("formats primary context with compact path and relationship tables", () => {
    const root = copyFixture("minimal");
    indexGodotProject(root);

    const responseText = textContent(
      callGodotMcpTool("godot_context", {
        projectPath: root,
        query: "FixtureActor",
        includeCode: true,
      }),
    );
    const response = JSON.parse(responseText) as Record<string, unknown>;
    const context = response.context as Record<string, unknown>;

    expect(context.paths).toEqual(
      expect.objectContaining({
        p1: "res://scripts/fixture_actor.gd",
      }),
    );
    expect(context.nodes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "n1",
          path: "p1",
        }),
      ]),
    );
    expect((context.nodes as Array<Record<string, unknown>>).every((node) => !("graphId" in node))).toBe(true);
    const nodes = context.nodes as Array<Record<string, unknown>>;
    const entryPoints = context.entryPoints as string[];
    expect(entryPoints.length).toBeGreaterThan(0);
    expect(entryPoints.every((id) => nodes.some((node) => node.id === id))).toBe(true);
    expect(context.relationships).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "attaches_script",
          from: expect.any(String),
          to: expect.any(String),
          provenance: expect.any(String),
        }),
      ]),
    );
    expect(context.snippets).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: "p1",
          text: expect.stringContaining("class_name FixtureActor"),
        }),
      ]),
    );
    expect(countSubstring(responseText, "res://scripts/fixture_actor.gd")).toBeLessThanOrEqual(3);
  });

  it("adds compact blast radius for edit-planning context", () => {
    const root = copyFixture("realistic-game");
    indexGodotProject(root);

    const responseText = textContent(
      callGodotMcpTool("godot_context", {
        projectPath: root,
        query: "edit FixtureActor damage flow",
        includeCode: false,
      }),
    );
    const response = JSON.parse(responseText) as Record<string, unknown>;
    const context = response.context as Record<string, unknown>;
    const blastRadius = context.blastRadius as Record<string, unknown>;

    expect(responseText.length).toBeLessThan(8_000);
    expect(blastRadius).toEqual(
      expect.objectContaining({
        entryPoints: expect.arrayContaining([expect.stringMatching(/^n\d+$/)]),
        checkFiles: expect.arrayContaining([expect.stringMatching(/^p\d+$/)]),
        relationshipCount: expect.any(Number),
      }),
    );
    const nodes = context.nodes as Array<Record<string, unknown>>;
    const paths = context.paths as Record<string, string>;
    expect((blastRadius.entryPoints as string[]).every((id) =>
      nodes.some((node) => node.id === id),
    )).toBe(true);
    expect((blastRadius.checkFiles as string[]).every((id) => id in paths)).toBe(true);
  });

  it("uses the conservative status payload when primary context has no usable index", () => {
    const root = mkdtempSync(join(tmpdir(), "gdgraph-mcp-context-no-index-"));
    tempRoots.push(root);

    expect(
      parseTextContent(callGodotMcpTool("godot_context", { projectPath: root, query: "Player" })),
    ).toEqual(
      expect.objectContaining({
        ok: false,
        initialized: false,
        indexFresh: false,
        message: expect.stringContaining("No gdgraph index"),
        nextTools: [
          expect.objectContaining({
            tool: "godot_sync",
            reason: expect.stringContaining("initialized=false"),
          }),
        ],
      }),
    );
  });

  it("returns friendly uninitialized status", () => {
    const root = mkdtempSync(join(tmpdir(), "gdgraph-mcp-empty-"));
    tempRoots.push(root);

    const response = parseTextContent(
      callGodotMcpTool("godot_status", { projectPath: root }),
    );

    expect(response).toEqual(
      expect.objectContaining({
        ok: false,
        initialized: false,
        indexFresh: false,
        nextTools: [
          expect.objectContaining({
            tool: "godot_sync",
            reason: expect.stringContaining("initialized=false"),
          }),
        ],
      }),
    );
    expect(response).not.toHaveProperty("projectRoot");
    expect(response).not.toHaveProperty("dbPath");
    expect(response).not.toHaveProperty("freshness");
  });

  it("marks an empty graph database as stale instead of fresh", () => {
    const root = mkdtempSync(join(tmpdir(), "gdgraph-mcp-empty-db-"));
    tempRoots.push(root);
    mkdirSync(join(root, ".gdgraph"), { recursive: true });

    const graph = createGraphDatabase(root);
    graph.close();

    expect(parseTextContent(callGodotMcpTool("godot_status", { projectPath: root }))).toEqual(
      expect.objectContaining({
        ok: false,
        initialized: true,
        indexEmpty: true,
        indexFresh: false,
        message: expect.stringContaining("empty"),
        nextTools: [
          expect.objectContaining({
            tool: "godot_sync",
            reason: expect.stringContaining("indexEmpty=true"),
          }),
        ],
      }),
    );
  });

  it("returns a structured tool error instead of throwing when graph data is invalid", () => {
    const root = copyFixture("minimal");
    const indexResult = indexGodotProject(root);
    expect(indexResult.ok).toBe(true);

    const graph = createGraphDatabase(root);
    try {
      graph.sqlite
        .prepare("update nodes set metadata = ? where id = ?")
        .run("{bad-json", "script:res://scripts/fixture_actor.gd");
    } finally {
      graph.close();
    }

    const response = parseTextContent(
      callGodotMcpTool("godot_context", { projectPath: root, query: "FixtureActor" }),
    );

    expect(response).toEqual(
      expect.objectContaining({
        ok: false,
        tool: "godot_context",
        error: expect.stringContaining("JSON"),
      }),
    );
  });

  it("reports live graph counts when index metadata is missing", () => {
    const root = copyFixture("minimal");
    const indexResult = indexGodotProject(root);
    expect(indexResult.ok).toBe(true);

    const graph = createGraphDatabase(root);
    try {
      graph.sqlite.prepare("delete from project_metadata where key = 'index'").run();
    } finally {
      graph.close();
    }

    expect(parseTextContent(callGodotMcpTool("godot_status", { projectPath: root }))).toEqual(
      expect.objectContaining({
        ok: true,
        initialized: true,
        fileCount: indexResult.fileCount,
        nodeCount: indexResult.nodeCount,
        edgeCount: indexResult.edgeCount,
        indexEmpty: false,
      }),
    );
  });

  it("reports unknown freshness timestamp source when sync and index metadata are missing", () => {
    const root = copyFixture("minimal");
    const indexResult = indexGodotProject(root);
    expect(indexResult.ok).toBe(true);

    const graph = createGraphDatabase(root);
    try {
      graph.sqlite.prepare("delete from project_metadata where key in ('sync', 'index')").run();
    } finally {
      graph.close();
    }

    expect(parseTextContent(callGodotMcpTool("godot_status", { projectPath: root }))).toEqual(
      expect.objectContaining({
        ok: true,
        initialized: true,
        indexFresh: true,
        pendingFiles: [],
        lastSyncAt: null,
        lastSyncAtSource: "unknown",
      }),
    );
  });

  it("keeps status payload concise", () => {
    const root = copyFixture("minimal");
    indexGodotProject(root);

    const response = parseTextContent(callGodotMcpTool("godot_status", { projectPath: root }));

    expect(response).toEqual({
      ok: true,
      initialized: true,
      indexEmpty: false,
      fileCount: 3,
      nodeCount: expect.any(Number),
      edgeCount: expect.any(Number),
      unresolvedRefCount: expect.any(Number),
      indexFresh: true,
      pendingFiles: [],
      pendingFileCount: 0,
      watcher: "disabled",
      lastSyncAt: expect.any(Number),
      lastSyncAtSource: "index",
    });
  });

  it("marks the index stale when a new Godot file exists without a watcher event", () => {
    const root = copyFixture("minimal");
    indexGodotProject(root);
    writeFileSync(
      join(root, "scripts", "new_profile_data.gd"),
      "extends Resource\nclass_name NewProfileData\n",
    );

    const response = parseTextContent(callGodotMcpTool("godot_status", { projectPath: root }));

    expect(response).toEqual(
      expect.objectContaining({
        ok: true,
        initialized: true,
        indexFresh: false,
        pendingFiles: expect.arrayContaining([
          { path: "res://scripts/new_profile_data.gd", indexing: false },
        ]),
      }),
    );
  });

  it("reads indexed file source through godot_node", () => {
    const root = copyFixture("minimal");
    const indexResult = indexGodotProject(root);
    expect(indexResult.ok).toBe(true);

    const response = parseTextContent(
      callGodotMcpTool("godot_node", {
        projectPath: root,
        file: "res://scripts/fixture_actor.gd",
        offset: 1,
        limit: 4,
      }),
    );

    expect(response).toEqual(
      expect.objectContaining({
        ok: true,
        paths: expect.objectContaining({
          p1: "res://scripts/fixture_actor.gd",
        }),
        target: expect.objectContaining({
          kind: "file",
          path: "p1",
        }),
        source: expect.objectContaining({
          path: "p1",
          start: 1,
          text: expect.stringContaining("1\textends CharacterBody2D"),
        }),
      }),
    );
    expect(response).not.toHaveProperty("projectRoot");
    expect(JSON.stringify(response)).not.toContain("filePath");
  });

  it("can read indexed file source without relationship notes", () => {
    const root = copyFixture("realistic-game");
    const indexResult = indexGodotProject(root);
    expect(indexResult.ok).toBe(true);

    const response = parseTextContent(
      callGodotMcpTool("godot_node", {
        projectPath: root,
        file: "res://scripts/actors/fixture_actor.gd",
        offset: 1,
        limit: 6,
        includeNotes: false,
      }),
    );

    expect(response).toEqual(
      expect.objectContaining({
        ok: true,
        target: expect.objectContaining({
          kind: "file",
          path: "p1",
        }),
        source: expect.objectContaining({
          path: "p1",
          text: expect.stringContaining("class_name FixtureActor"),
        }),
      }),
    );
    expect(response).not.toHaveProperty("notes");
    expect(response).not.toHaveProperty("symbols");
    expect(JSON.stringify(response)).not.toContain("filePath");
  });

  it("returns compact symbols-only file payload without repeated file paths", () => {
    const root = copyFixture("realistic-game");
    const indexResult = indexGodotProject(root);
    expect(indexResult.ok).toBe(true);

    const responseText = textContent(
      callGodotMcpTool("godot_node", {
        projectPath: root,
        file: "res://scripts/actors/fixture_actor.gd",
        symbolsOnly: true,
      }),
    );
    const response = JSON.parse(responseText) as Record<string, unknown>;
    const symbols = response.symbols as Array<Record<string, unknown>>;
    const notes = response.notes as Record<string, Array<Record<string, unknown>>>;

    expect(response).toEqual(expect.objectContaining({
      ok: true,
      paths: expect.objectContaining({
        p1: "res://scripts/actors/fixture_actor.gd",
      }),
      target: expect.objectContaining({
        kind: "file",
        path: "p1",
      }),
    }));
    expect(symbols.length).toBeGreaterThan(5);
    expect(symbols.every((symbol) => symbol.path === "p1")).toBe(true);
    expect(symbols.every((symbol) => /^n\d+$/.test(String(symbol.id)))).toBe(true);
    const symbolIds = new Set(symbols.map((symbol) => symbol.id));
    const repeatedEntries = noteEntries(notes).filter((entry) => symbolIds.has(entry.id));
    expect(repeatedEntries.length).toBeGreaterThan(0);
    expect(repeatedEntries.every((entry) => Object.keys(entry).join(",") === "id")).toBe(true);
    expect(notes.dependents.every((node) => !("filePath" in node))).toBe(true);
    expect(responseText).not.toContain("filePath");
    expect(responseText).not.toContain("graphId");
    expect(countSubstring(responseText, "res://scripts/actors/fixture_actor.gd")).toBe(1);
  });

  it("reads indexed symbol source through godot_node", () => {
    const root = copyFixture("minimal");
    const indexResult = indexGodotProject(root);
    expect(indexResult.ok).toBe(true);

    const response = parseTextContent(
      callGodotMcpTool("godot_node", {
        projectPath: root,
        symbol: "FixtureActor",
      }),
    );

    expect(response).toEqual(
      expect.objectContaining({
        ok: true,
        target: expect.objectContaining({
          kind: "script_class",
          id: expect.stringMatching(/^n\d+$/),
          path: "p1",
        }),
        source: expect.objectContaining({
          path: "p1",
          text: expect.stringContaining("class_name FixtureActor"),
        }),
      }),
    );
    expect(response.paths).toEqual(expect.objectContaining({
      p1: "res://scripts/fixture_actor.gd",
    }));
    expect(JSON.stringify(response)).not.toContain("filePath");
  });

  it("scopes godot_node symbol lookup by file when both are provided", () => {
    const root = copyFixture("minimal");
    writeFileSync(
      join(root, "scripts", "node_scope_a.gd"),
      "extends Node\nclass_name NodeScopeA\n\nfunc shared_name() -> void:\n\tpass\n",
    );
    writeFileSync(
      join(root, "scripts", "node_scope_b.gd"),
      "extends Node\nclass_name NodeScopeB\n\nfunc shared_name() -> void:\n\tpass\n",
    );
    const indexResult = indexGodotProject(root);
    expect(indexResult.ok).toBe(true);

    const response = parseTextContent(
      callGodotMcpTool("godot_node", {
        projectPath: root,
        file: "res://scripts/node_scope_b.gd",
        symbol: "shared_name",
      }),
    );

    expect(response).toEqual(
      expect.objectContaining({
        ok: true,
        target: expect.objectContaining({
          id: expect.stringMatching(/^n\d+$/),
          path: "p1",
        }),
        source: expect.objectContaining({
          path: "p1",
          text: expect.stringContaining("func shared_name() -> void:"),
        }),
      }),
    );
    expect(response.paths).toEqual(expect.objectContaining({
      p1: "res://scripts/node_scope_b.gd",
    }));
  });

  it("rejects mixed godot_node id selectors", () => {
    const root = copyFixture("minimal");
    const indexResult = indexGodotProject(root);
    expect(indexResult.ok).toBe(true);

    const response = parseTextContent(
      callGodotMcpTool("godot_node", {
        projectPath: root,
        id: "script:res://scripts/fixture_actor.gd",
        symbol: "FixtureActor",
      }),
    );

    expect(response).toEqual(
      expect.objectContaining({
        ok: false,
        error: "godot_node id selector cannot be combined with file or symbol.",
        indexFresh: true,
        pendingFileCount: 0,
        watcher: "disabled",
        lastSyncAt: expect.any(Number),
      }),
    );
  });

  it("reads indexed method body through godot_node", () => {
    const root = copyFixture("minimal");
    writeFileSync(
      join(root, "scripts", "node_reader_target.gd"),
      `extends Node
class_name NodeReaderTarget

func first() -> void:
\tpass

func target_method() -> void:
\tvar value := 1
\tvalue += 1

func after() -> void:
\tpass
`,
    );
    const indexResult = indexGodotProject(root);
    expect(indexResult.ok).toBe(true);

    const response = parseTextContent(
      callGodotMcpTool("godot_node", {
        projectPath: root,
        symbol: "target_method",
        includeCode: true,
      }),
    );
    const source = response.source as Record<string, unknown>;

    expect(response).toEqual(
      expect.objectContaining({
        ok: true,
        target: expect.objectContaining({
          kind: "method",
          name: "target_method",
          path: expect.any(String),
        }),
      }),
    );
    expect(source.start).toBe(7);
    expect(source.text).toEqual(expect.stringContaining("7\tfunc target_method() -> void:"));
    expect(source.text).not.toEqual(expect.stringContaining("func first"));
    expect(source.text).not.toEqual(expect.stringContaining("func after"));
  });

  it("returns relationship notes for godot_node targets", () => {
    const root = copyFixture("signals");
    const indexResult = indexGodotProject(root);
    expect(indexResult.ok).toBe(true);

    const response = parseTextContent(
      callGodotMcpTool("godot_node", {
        projectPath: root,
        symbol: "damage",
        includeCode: false,
      }),
    );
    const notes = response.notes as Record<string, unknown[]>;

    expect(notes.callers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "_on_start_button_pressed",
          kind: "method",
          path: "p1",
        }),
      ]),
    );
    expect(response.paths).toEqual(expect.objectContaining({
      p1: "res://scripts/signal_demo.gd",
    }));
    expect(notes.callees).toEqual(expect.any(Array));
    expect(notes.dependents).toEqual(expect.any(Array));
    expect(notes.dependencies).toEqual(expect.any(Array));
  });

  it("prioritizes cross-file symbol references in bounded godot_node notes", () => {
    const root = copyFixture("minimal");
    writeFileSync(
      join(root, "scripts", "step_catalog.gd"),
      [
        "extends Node",
        "class_name StepCatalog",
        "",
        "const FIXTURE_STEP_NAME := \"entry\"",
        "",
        ...Array.from(
          { length: 12 },
          (_, index) => [
            `func local_read_${index}() -> String:`,
            "\treturn FIXTURE_STEP_NAME",
            "",
          ].join("\n"),
        ),
      ].join("\n"),
    );
    writeFileSync(
      join(root, "scripts", "step_reader.gd"),
      [
        "extends Node",
        "class_name StepReader",
        "",
        "func play() -> String:",
        "\treturn StepCatalog.FIXTURE_STEP_NAME",
        "",
      ].join("\n"),
    );
    const indexResult = indexGodotProject(root);
    expect(indexResult.ok).toBe(true);

    const response = parseTextContent(
      callGodotMcpTool("godot_node", {
        projectPath: root,
        symbol: "StepCatalog.FIXTURE_STEP_NAME",
        includeCode: false,
      }),
    );
    const notes = response.notes as Record<string, unknown>;
    const dependents = notes.dependents as Array<Record<string, unknown>>;
    const omitted = notes.omitted as Record<string, unknown>;

    expect(notes.limit).toBe(8);
    expect(notes.complete).toBe(false);
    expect(response.resultHint).toBe("navigation_sample_not_exhaustive");
    expect(omitted.dependents).toBeGreaterThan(0);
    expect(dependents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "method",
          name: "play",
          path: expect.any(String),
        }),
      ]),
    );
    expect(JSON.stringify(response)).not.toContain("filePath");
  });

  it("reports complete relationship notes for resolved symbol dependents", () => {
    const root = copyFixture("symbol-dependents");
    const result = indexGodotProject(root);
    expect(result.ok).toBe(true);

    const response = parseTextContent(
      callGodotMcpTool("godot_node", {
        projectPath: root,
        symbol: "FixtureLimits.FIXTURE_LIMIT",
        includeCode: false,
      }),
    );
    const notes = response.notes as Record<string, unknown>;
    const dependents = notes.dependents as Array<Record<string, unknown>>;

    expect(notes.complete).toBe(true);
    expect(dependents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "method", name: "local_limit" }),
        expect.objectContaining({ kind: "method", name: "class_limit" }),
        expect.objectContaining({ kind: "method", name: "preload_limit" }),
      ]),
    );
    expect(JSON.stringify(response)).not.toContain("filePath");
    expect(JSON.stringify(response)).not.toContain("graphId");
  });

  it("reads indexed scene node source through godot_node", () => {
    const root = copyFixture("minimal");
    const indexResult = indexGodotProject(root);
    expect(indexResult.ok).toBe(true);

    const response = parseTextContent(
      callGodotMcpTool("godot_node", {
        projectPath: root,
        id: "scene_node:res://fixture_main.tscn:FixtureActor",
      }),
    );

    expect(response).toEqual(
      expect.objectContaining({
        ok: true,
        paths: expect.objectContaining({
          p1: "res://fixture_main.tscn",
        }),
        target: expect.objectContaining({
          kind: "scene_node",
          path: "p1",
        }),
        source: expect.objectContaining({
          path: "p1",
          text: expect.stringContaining("FixtureActor"),
        }),
      }),
    );
  });

  it("flags stale selected files in godot_node responses", () => {
    const root = copyFixture("minimal");
    const indexResult = indexGodotProject(root);
    expect(indexResult.ok).toBe(true);
    globalPendingFileTracker.markPending(root, "res://scripts/fixture_actor.gd");

    const response = parseTextContent(
      callGodotMcpTool("godot_node", {
        projectPath: root,
        file: "res://scripts/fixture_actor.gd",
        includeCode: false,
      }),
    );

    expect(response).toEqual(
      expect.objectContaining({
        ok: true,
        indexFresh: false,
        stale: true,
        paths: expect.objectContaining({
          p1: "res://scripts/fixture_actor.gd",
        }),
        staleFiles: ["p1"],
      }),
    );
  });

  it("returns a concise godot_node error when no target is provided", () => {
    const root = copyFixture("minimal");
    const indexResult = indexGodotProject(root);
    expect(indexResult.ok).toBe(true);

    expect(parseTextContent(callGodotMcpTool("godot_node", { projectPath: root }))).toEqual(
      expect.objectContaining({
        ok: false,
        error: expect.stringContaining("file, symbol, or id"),
      }),
    );
  });

  it("keeps primary MCP graph responses compact", () => {
    const root = copyFixture("realistic-game");
    rmSync(join(root, ".gdgraph"), { force: true, recursive: true });
    const indexResult = indexGodotProject(root);
    expect(indexResult.ok).toBe(true);

    const calls = {
      godot_context: callGodotMcpTool("godot_context", {
        projectPath: root,
        query: "FixtureActor MainController FixtureState signal input scene",
        includeCode: true,
        maxFiles: 8,
      }),
      godot_node: callGodotMcpTool("godot_node", {
        projectPath: root,
        symbol: "FixtureActor",
        includeCode: true,
      }),
      godot_node_symbols: callGodotMcpTool("godot_node", {
        projectPath: root,
        file: "res://scripts/actors/fixture_actor.gd",
        symbolsOnly: true,
      }),
    };

    const metrics = Object.fromEntries(
      Object.entries(calls).map(([tool, result]) => [tool, textContent(result).length]),
    ) as Record<keyof typeof calls, number>;

    expect(metrics.godot_context).toBeLessThan(8_000);
    expect(metrics.godot_node).toBeLessThan(8_000);
    expect(metrics.godot_node_symbols).toBeLessThan(8_000);
    expect(countSubstring(textContent(calls.godot_node_symbols), "res://scripts/actors/fixture_actor.gd")).toBe(1);
  });

  it("omits large MCP sync file lists", () => {
    const root = copyFixture("minimal");
    indexGodotProject(root);
    for (let index = 0; index < 30; index += 1) {
      writeFileSync(
        join(root, "scripts", `bulk_added_${index}.gd`),
        `extends Node\nclass_name BulkAdded${index}\n`,
      );
    }

    const responseText = textContent(callGodotMcpTool("godot_sync", { projectPath: root }));
    const response = JSON.parse(responseText) as Record<string, unknown>;

    expect(response).toEqual(
      expect.objectContaining({
        ok: true,
        addedCount: 30,
        modifiedCount: 0,
        deletedCount: 0,
        changeListsOmitted: true,
        parseErrorCount: 0,
      }),
    );
    expect(response).not.toHaveProperty("projectRoot");
    expect(response).not.toHaveProperty("databasePath");
    expect(response).not.toHaveProperty("pendingFiles");
    expect(response).not.toHaveProperty("freshness");
    expect(response).not.toHaveProperty("added");
    expect(response).not.toHaveProperty("modified");
    expect(response).not.toHaveProperty("deleted");
    expect(responseText).not.toContain("bulk_added_29.gd");
    expect(responseText.length).toBeLessThan(4_000);
  });

  it("omits local paths from MCP sync errors", () => {
    const root = mkdtempSync(join(tmpdir(), "gdgraph-mcp-empty-"));
    tempRoots.push(root);

    const responseText = textContent(callGodotMcpTool("godot_sync", { projectPath: root }));
    const response = JSON.parse(responseText) as Record<string, unknown>;

    expect(response).toEqual(
      expect.objectContaining({
        ok: false,
        reason: "missing_project_godot",
      }),
    );
    expect(response).not.toHaveProperty("projectRoot");
    expect(responseText).not.toContain(root);
  });
});
