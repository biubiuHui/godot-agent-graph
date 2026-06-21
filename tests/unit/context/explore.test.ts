import { cpSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { createGraphDatabase, type GraphDatabase } from "../../../src/db/index.js";
import {
  insertEdge,
  insertUnresolvedRef,
  upsertFile,
  upsertNode,
} from "../../../src/db/queries.js";
import {
  exploreGodotContext,
  getCalleesContext,
  getCallersContext,
  getSymbolContext,
} from "../../../src/context/explore.js";
import { indexGodotProject } from "../../../src/indexer/indexer.js";
import type { EdgeKind, GraphFile, GraphNode, NodeKind } from "../../../src/types.js";

const fixturesRoot = fileURLToPath(new URL("../../fixtures/godot", import.meta.url));
const tempRoots: string[] = [];

function indexedFixture(name: string): string {
  const root = mkdtempSync(join(tmpdir(), `gdgraph-context-${name}-`));
  tempRoots.push(root);
  cpSync(join(fixturesRoot, name), root, { recursive: true });
  const result = indexGodotProject(root);
  expect(result.ok).toBe(true);
  return root;
}

function createTempGraph(): GraphDatabase {
  const root = mkdtempSync(join(tmpdir(), "gdgraph-context-manual-"));
  tempRoots.push(root);
  return createGraphDatabase(root);
}

function addFile(graph: GraphDatabase, path: string): GraphFile {
  const file: GraphFile = {
    path,
    kind: "gdscript",
    contentHash: path,
    size: 1,
    modifiedAt: 1,
    indexedAt: 1,
    nodeCount: 1,
    parseErrors: [],
  };
  upsertFile(graph, file);
  return file;
}

function addNode(
  graph: GraphDatabase,
  id: string,
  kind: NodeKind,
  name: string,
  qualifiedName: string,
  filePath: string,
): GraphNode {
  const node: GraphNode = {
    id,
    kind,
    name,
    qualifiedName,
    filePath,
    startLine: 1,
    endLine: 1,
    signature: kind,
    metadata: {},
    updatedAt: 1,
  };
  upsertNode(graph, node);
  return node;
}

function addEdge(graph: GraphDatabase, source: string, kind: EdgeKind, target: string): void {
  insertEdge(graph, {
    source,
    target,
    kind,
    line: 1,
    column: 1,
    provenance: "resolver",
    metadata: {},
  });
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
});

describe("agent context queries", () => {
  it("explores related Godot context with relationship explanations and bounded snippets", () => {
    const root = indexedFixture("minimal");
    const graph = createGraphDatabase(root);
    try {
      const context = exploreGodotContext(graph, {
        projectRoot: root,
        query: "FixtureActor",
        maxFiles: 1,
        includeCode: true,
      });

      expect(context.nodes.map((node) => node.id)).toEqual(
        expect.arrayContaining([
          "script:res://scripts/fixture_actor.gd",
          "scene_node:res://fixture_main.tscn:FixtureActor",
          "method:res://scripts/fixture_actor.gd:_ready",
        ]),
      );
      expect(context.nodes[0]).not.toHaveProperty("metadata");
      expect(context.nodes[0]).not.toHaveProperty("updatedAt");
      expect(context.relationships).toEqual(
        expect.arrayContaining([
          expect.stringContaining("scene_node:res://fixture_main.tscn:FixtureActor attaches_script script:res://scripts/fixture_actor.gd"),
        ]),
      );
      expect(context.relationships).not.toEqual(
        expect.arrayContaining([
          expect.stringContaining("scene_node:res://fixture_main.tscn:FixtureActor attaches_script resource:res://scripts/fixture_actor.gd"),
        ]),
      );
      expect(context.files).toEqual(["res://scripts/fixture_actor.gd"]);
      expect(context.snippets).toEqual([
        expect.objectContaining({
          filePath: "res://scripts/fixture_actor.gd",
          text: expect.stringContaining("class_name FixtureActor"),
        }),
      ]);
    } finally {
      graph.close();
    }
  });

  it("returns symbol details without code snippets when requested", () => {
    const root = indexedFixture("minimal");
    const graph = createGraphDatabase(root);
    try {
      const context = getSymbolContext(graph, {
        projectRoot: root,
        symbol: "FixtureActor",
        includeCode: false,
      });

      expect(context.nodes).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: "script:res://scripts/fixture_actor.gd" }),
        expect.objectContaining({ id: "scene_node:res://fixture_main.tscn:FixtureActor" }),
      ]));
      expect(context.snippets).toEqual([]);
    } finally {
      graph.close();
    }
  });

  it("does not show resolved autoload root lookups as unresolved node paths", () => {
    const root = indexedFixture("autoload-input");
    const graph = createGraphDatabase(root);
    try {
      const context = exploreGodotContext(graph, {
        projectRoot: root,
        query: "FixtureState",
        includeCode: false,
      });

      expect(context.relationships).toEqual(
        expect.arrayContaining([
          expect.stringContaining("script:res://scripts/fixture_input.gd uses_autoload autoload:FixtureState"),
        ]),
      );
      expect(context.relationships).not.toEqual(
        expect.arrayContaining([
          expect.stringContaining("references_nodepath /root/FixtureState (unresolved)"),
        ]),
      );
      expect(context.relationships).not.toEqual(
        expect.arrayContaining([
          expect.stringContaining("references_nodepath FixtureState (unresolved)"),
        ]),
      );
    } finally {
      graph.close();
    }
  });

  it("returns callers and callees contexts", () => {
    const root = indexedFixture("signals");
    const graph = createGraphDatabase(root);
    try {
      const callers = getCallersContext(graph, {
        projectRoot: root,
        symbol: "damage",
      });
      expect(callers.relationships).toEqual(
        expect.arrayContaining([
          expect.stringContaining(
            "method:res://scripts/signal_demo.gd:_on_start_button_pressed calls method:res://scripts/signal_demo.gd:damage",
          ),
        ]),
      );
      expect(callers.relationships).not.toEqual(
        expect.arrayContaining([
          expect.stringContaining("calls method:res://scripts/signal_demo.gd:damage (unresolved-match)"),
        ]),
      );

      const callees = getCalleesContext(graph, {
        projectRoot: root,
        symbol: "SignalDemo",
      });
      expect(callees.relationships).not.toEqual(
        expect.arrayContaining([
          expect.stringContaining("calls damage (unresolved)"),
        ]),
      );
      expect(callees.nodes.map((node) => node.id)).toEqual(
        expect.arrayContaining([
          "method:res://scripts/signal_demo.gd:_ready",
          "method:res://scripts/signal_demo.gd:damage",
        ]),
      );
    } finally {
      graph.close();
    }
  });

  it("keeps unresolved caller matches ambiguous instead of linking them to every same-name method", () => {
    const graph = createTempGraph();
    try {
      addFile(graph, "res://scripts/a.gd");
      addFile(graph, "res://scripts/b.gd");
      addFile(graph, "res://scripts/caller.gd");
      addFile(graph, "res://scripts/resolved_caller.gd");
      addNode(graph, "script:res://scripts/a.gd", "script_class", "A", "A", "res://scripts/a.gd");
      addNode(graph, "script:res://scripts/b.gd", "script_class", "B", "B", "res://scripts/b.gd");
      addNode(
        graph,
        "script:res://scripts/caller.gd",
        "script_class",
        "Caller",
        "Caller",
        "res://scripts/caller.gd",
      );
      addNode(
        graph,
        "script:res://scripts/resolved_caller.gd",
        "script_class",
        "ResolvedCaller",
        "ResolvedCaller",
        "res://scripts/resolved_caller.gd",
      );
      addNode(
        graph,
        "method:res://scripts/a.gd:validate",
        "method",
        "validate",
        "A.validate",
        "res://scripts/a.gd",
      );
      addNode(
        graph,
        "method:res://scripts/b.gd:validate",
        "method",
        "validate",
        "B.validate",
        "res://scripts/b.gd",
      );
      addEdge(
        graph,
        "script:res://scripts/resolved_caller.gd",
        "calls",
        "method:res://scripts/a.gd:validate",
      );
      insertUnresolvedRef(graph, {
        fromNodeId: "script:res://scripts/caller.gd",
        referenceName: "validate",
        referenceKind: "calls",
        filePath: "res://scripts/caller.gd",
        line: 1,
        column: 1,
        candidates: [],
      });

      const callers = getCallersContext(graph, {
        projectRoot: graph.projectRoot,
        symbol: "validate",
        includeCode: false,
      });

      expect(callers.relationships).toContain(
        "script:res://scripts/resolved_caller.gd calls method:res://scripts/a.gd:validate (resolver)",
      );
      expect(callers.relationships).toContain(
        "script:res://scripts/caller.gd calls validate (unresolved)",
      );
      expect(callers.relationships).not.toEqual(
        expect.arrayContaining([expect.stringContaining("(unresolved-match)")]),
      );
      expect(callers.relationships.indexOf(
        "script:res://scripts/resolved_caller.gd calls method:res://scripts/a.gd:validate (resolver)",
      )).toBeLessThan(callers.relationships.indexOf(
        "script:res://scripts/caller.gd calls validate (unresolved)",
      ));
    } finally {
      graph.close();
    }
  });

  it("shows resolved autoload receiver calls instead of unresolved caller matches", () => {
    const root = indexedFixture("minimal");
    writeFileSync(
      join(root, "project.godot"),
      `; Engine configuration file.

[application]

config/name="MinimalFixture"
run/main_scene="res://fixture_main.tscn"

[autoload]

FixtureFx="*res://scripts/fixture_fx.gd"
`,
    );
    writeFileSync(
      join(root, "scripts", "fixture_fx.gd"),
      `extends Node
class_name FixtureFxClass

func request_fixture_feedback() -> void:
\tpass
`,
    );
    writeFileSync(
      join(root, "scripts", "other_fx.gd"),
      `extends Node
class_name OtherFx

func request_fixture_feedback() -> void:
\tpass
`,
    );
    writeFileSync(
      join(root, "scripts", "autoload_caller.gd"),
      `extends Node
class_name AutoloadCaller

func _ready() -> void:
\tFixtureFx.request_fixture_feedback()
`,
    );
    const result = indexGodotProject(root);
    expect(result.ok).toBe(true);

    const graph = createGraphDatabase(root);
    try {
      const callers = getCallersContext(graph, {
        projectRoot: root,
        symbol: "request_fixture_feedback",
        includeCode: false,
      });

      expect(callers.relationships).toContain(
        "method:res://scripts/autoload_caller.gd:_ready calls method:res://scripts/fixture_fx.gd:request_fixture_feedback (resolver)",
      );
      expect(callers.relationships).not.toContain(
        "method:res://scripts/autoload_caller.gd:_ready calls request_fixture_feedback (unresolved)",
      );
    } finally {
      graph.close();
    }
  });

  it("shows resolved typed collection entry calls instead of unresolved relationships", () => {
    const root = indexedFixture("minimal");
    writeFileSync(
      join(root, "scripts", "fixture_cell.gd"),
      `extends RefCounted
class_name FixtureCell

func play_fixture_feedback_animation() -> void:
\tpass
`,
    );
    writeFileSync(
      join(root, "scripts", "other_cell.gd"),
      `extends RefCounted
class_name OtherCell

func play_fixture_feedback_animation() -> void:
\tpass
`,
    );
    writeFileSync(
      join(root, "scripts", "fixture_panel.gd"),
      `extends Node
class_name FixturePanel

var cells: Array[FixtureCell] = []

func apply_fixture_state() -> void:
\tfor cell_view in cells:
\t\tcell_view.play_fixture_feedback_animation()
`,
    );
    const result = indexGodotProject(root);
    expect(result.ok).toBe(true);

    const graph = createGraphDatabase(root);
    try {
      const context = exploreGodotContext(graph, {
        projectRoot: root,
        query: "play_fixture_feedback_animation",
        includeCode: false,
      });

      expect(context.relationships).toContain(
        "method:res://scripts/fixture_panel.gd:apply_fixture_state calls method:res://scripts/fixture_cell.gd:play_fixture_feedback_animation (resolver)",
      );
      expect(context.relationships).not.toContain(
        "method:res://scripts/fixture_panel.gd:apply_fixture_state calls play_fixture_feedback_animation (unresolved)",
      );
    } finally {
      graph.close();
    }
  });

  it("shows signal declaration relationships for signal connection callers", () => {
    const root = indexedFixture("minimal");
    writeFileSync(
      join(root, "project.godot"),
      `; Engine configuration file.

[application]

config/name="MinimalFixture"
run/main_scene="res://fixture_main.tscn"

[autoload]

FixtureFx="*res://scripts/fixture_fx.gd"
`,
    );
    writeFileSync(
      join(root, "scripts", "fixture_fx.gd"),
      `extends Node
class_name FixtureFxClass

signal fixture_feedback_requested
`,
    );
    writeFileSync(
      join(root, "scripts", "signal_caller.gd"),
      `extends Node
class_name SignalCaller

func _ensure_fixture_connections() -> void:
\tFixtureFx.fixture_feedback_requested.connect(_on_fixture_feedback_requested)

func _on_fixture_feedback_requested() -> void:
\tpass
`,
    );
    const result = indexGodotProject(root);
    expect(result.ok).toBe(true);

    const graph = createGraphDatabase(root);
    try {
      const callers = getCallersContext(graph, {
        projectRoot: root,
        symbol: "fixture_feedback_requested",
        includeCode: false,
      });

      expect(callers.relationships).toContain(
        "method:res://scripts/signal_caller.gd:_ensure_fixture_connections connects_signal signal:res://scripts/fixture_fx.gd:fixture_feedback_requested (resolver)",
      );
      expect(callers.relationships).not.toContain(
        "method:res://scripts/signal_caller.gd:_ensure_fixture_connections connects_signal fixture_feedback_requested (unresolved)",
      );
    } finally {
      graph.close();
    }
  });
});
