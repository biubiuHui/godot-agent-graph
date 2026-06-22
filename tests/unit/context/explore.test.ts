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
  it("preserves exact entry point symbols in broad natural-language queries", () => {
    const graph = createTempGraph();
    try {
      function insertScriptClass(name: string, path: string): void {
        addFile(graph, path);
        addNode(graph, `script:${path}`, "script_class", name, name, path);
      }

      for (let index = 0; index < 14; index += 1) {
        insertScriptClass(`ModuleNoise${index}`, `res://scripts/module_noise_${index}.gd`);
      }
      insertScriptClass("ExactAlphaController", "res://scripts/exact_alpha_controller.gd");
      insertScriptClass("ExactBetaTimeline", "res://scripts/exact_beta_timeline.gd");
      insertScriptClass("ExactActionPanel", "res://scripts/exact_action_panel.gd");
      insertScriptClass("ExactMainScreen", "res://scripts/exact_main_screen.gd");

      const context = exploreGodotContext(graph, {
        projectRoot: "",
        query: "Module 6 broad fixture event flow ExactAlphaController ExactBetaTimeline ExactActionPanel ExactMainScreen",
        includeCode: false,
      });
      const entryPointNames = context.entryPoints
        .map((id) => context.nodes.find((node) => node.id === id)?.name)
        .filter(Boolean);

      expect(entryPointNames.slice(0, 4)).toEqual(
        expect.arrayContaining([
          "ExactAlphaController",
          "ExactBetaTimeline",
          "ExactActionPanel",
          "ExactMainScreen",
        ]),
      );
      const noiseIndex = entryPointNames.indexOf("ModuleNoise0");
      if (noiseIndex >= 0) {
        expect(entryPointNames.indexOf("ExactAlphaController")).toBeLessThan(noiseIndex);
      }
    } finally {
      graph.close();
    }
  });

  it("returns focused direct paths between entry points", () => {
    const graph = createTempGraph();
    try {
      addFile(graph, "res://scripts/screen_controller.gd");
      addFile(graph, "res://scripts/timeline_builder.gd");
      addNode(
        graph,
        "script:res://scripts/screen_controller.gd",
        "script_class",
        "ScreenController",
        "ScreenController",
        "res://scripts/screen_controller.gd",
      );
      addNode(
        graph,
        "script:res://scripts/timeline_builder.gd",
        "script_class",
        "TimelineBuilder",
        "TimelineBuilder",
        "res://scripts/timeline_builder.gd",
      );
      addNode(
        graph,
        "method:res://scripts/screen_controller.gd:_ready",
        "method",
        "_ready",
        "ScreenController._ready",
        "res://scripts/screen_controller.gd",
      );
      addEdge(
        graph,
        "script:res://scripts/screen_controller.gd",
        "calls",
        "script:res://scripts/timeline_builder.gd",
      );
      addEdge(
        graph,
        "script:res://scripts/screen_controller.gd",
        "contains",
        "method:res://scripts/screen_controller.gd:_ready",
      );

      const context = exploreGodotContext(graph, {
        projectRoot: "",
        query: "ScreenController TimelineBuilder flow",
        includeCode: false,
      });

      expect(context.pathsBetween).toEqual([
        "script:res://scripts/screen_controller.gd calls script:res://scripts/timeline_builder.gd (resolver)",
      ]);
      expect(context.pathsBetween).not.toEqual(
        expect.arrayContaining([expect.stringContaining(" contains ")]),
      );
    } finally {
      graph.close();
    }
  });

  it("keeps edit blast radius check files focused on direct relationships", () => {
    const graph = createTempGraph();
    try {
      addFile(graph, "res://scripts/target_service.gd");
      addFile(graph, "res://scripts/direct_panel.gd");
      addFile(graph, "res://scripts/unrelated_service.gd");
      addNode(
        graph,
        "script:res://scripts/target_service.gd",
        "script_class",
        "TargetService",
        "TargetService",
        "res://scripts/target_service.gd",
      );
      addNode(
        graph,
        "method:res://scripts/target_service.gd:target_method",
        "method",
        "target_method",
        "TargetService.target_method",
        "res://scripts/target_service.gd",
      );
      addNode(
        graph,
        "method:res://scripts/direct_panel.gd:call_target",
        "method",
        "call_target",
        "DirectPanel.call_target",
        "res://scripts/direct_panel.gd",
      );
      addNode(
        graph,
        "method:res://scripts/direct_panel.gd:unrelated_branch",
        "method",
        "unrelated_branch",
        "DirectPanel.unrelated_branch",
        "res://scripts/direct_panel.gd",
      );
      addNode(
        graph,
        "method:res://scripts/unrelated_service.gd:unrelated_method",
        "method",
        "unrelated_method",
        "UnrelatedService.unrelated_method",
        "res://scripts/unrelated_service.gd",
      );
      addEdge(
        graph,
        "script:res://scripts/target_service.gd",
        "contains",
        "method:res://scripts/target_service.gd:target_method",
      );
      addEdge(
        graph,
        "method:res://scripts/direct_panel.gd:call_target",
        "calls",
        "method:res://scripts/target_service.gd:target_method",
      );
      addEdge(
        graph,
        "method:res://scripts/direct_panel.gd:unrelated_branch",
        "calls",
        "method:res://scripts/unrelated_service.gd:unrelated_method",
      );

      const context = exploreGodotContext(graph, {
        projectRoot: "",
        query: "change target_method",
        includeCode: false,
      });

      expect(context.blastRadius?.checkFiles).toEqual(
        expect.arrayContaining([
          "res://scripts/target_service.gd",
          "res://scripts/direct_panel.gd",
        ]),
      );
      expect(context.blastRadius?.checkFiles).not.toContain("res://scripts/unrelated_service.gd");
    } finally {
      graph.close();
    }
  });

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

func _connect_example_signal() -> void:
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
        "method:res://scripts/signal_caller.gd:_connect_example_signal connects_signal signal:res://scripts/fixture_fx.gd:fixture_feedback_requested (resolver)",
      );
      expect(callers.relationships).not.toContain(
        "method:res://scripts/signal_caller.gd:_connect_example_signal connects_signal fixture_feedback_requested (unresolved)",
      );
    } finally {
      graph.close();
    }
  });

  it("shows callers for class constant references", () => {
    const root = indexedFixture("minimal");
    writeFileSync(
      join(root, "scripts", "step_catalog.gd"),
      `extends Node
class_name StepCatalog

const FIXTURE_STEP_NAME := "fixture_step"
`,
    );
    writeFileSync(
      join(root, "scripts", "step_reader.gd"),
      `extends Node
class_name StepReader

func play() -> void:
\tif StepCatalog.FIXTURE_STEP_NAME == "fixture_step":
\t\tpass
`,
    );
    const result = indexGodotProject(root);
    expect(result.ok).toBe(true);

    const graph = createGraphDatabase(root);
    try {
      const callers = getCallersContext(graph, {
        projectRoot: root,
        symbol: "FIXTURE_STEP_NAME",
        includeCode: false,
        maxFiles: 10,
      });

      expect(callers.nodes.map((node) => node.id)).toContain(
        "property:res://scripts/step_catalog.gd:FIXTURE_STEP_NAME",
      );
      expect(callers.files).toContain("res://scripts/step_catalog.gd");
      expect(callers.files).toContain("res://scripts/step_reader.gd");
      expect(callers.relationships).toEqual(
        expect.arrayContaining([
          expect.stringContaining(
            "method:res://scripts/step_reader.gd:play references_symbol property:res://scripts/step_catalog.gd:FIXTURE_STEP_NAME",
          ),
        ]),
      );
    } finally {
      graph.close();
    }
  });

  it("keeps ambiguous same-name symbol references unresolved", () => {
    const root = indexedFixture("minimal");
    writeFileSync(
      join(root, "scripts", "first_catalog.gd"),
      `extends Node
class_name FirstCatalog

const SHARED_VALUE := 1
`,
    );
    writeFileSync(
      join(root, "scripts", "second_catalog.gd"),
      `extends Node
class_name SecondCatalog

const SHARED_VALUE := 2
`,
    );
    writeFileSync(
      join(root, "scripts", "ambiguous_reader.gd"),
      `extends Node
class_name AmbiguousReader

func read_value() -> int:
\treturn SHARED_VALUE
`,
    );
    const result = indexGodotProject(root);
    expect(result.ok).toBe(true);

    const graph = createGraphDatabase(root);
    try {
      const callers = getCallersContext(graph, {
        projectRoot: root,
        symbol: "SHARED_VALUE",
        includeCode: false,
        maxFiles: 10,
      });

      expect(callers.relationships).toEqual(
        expect.arrayContaining([
          "method:res://scripts/ambiguous_reader.gd:read_value references_symbol SHARED_VALUE (unresolved)",
        ]),
      );
      expect(callers.relationships).not.toEqual(
        expect.arrayContaining([
          expect.stringContaining(
            "method:res://scripts/ambiguous_reader.gd:read_value references_symbol property:res://scripts/first_catalog.gd:SHARED_VALUE",
          ),
        ]),
      );
      expect(callers.relationships).not.toEqual(
        expect.arrayContaining([
          expect.stringContaining(
            "method:res://scripts/ambiguous_reader.gd:read_value references_symbol property:res://scripts/second_catalog.gd:SHARED_VALUE",
          ),
        ]),
      );
    } finally {
      graph.close();
    }
  });

  it("documents current includeCode snippets start at file heads", () => {
    const root = indexedFixture("minimal");
    writeFileSync(
      join(root, "scripts", "many_lines.gd"),
      `extends Node
class_name ManyLines

func intro() -> void:
\tpass
















func target_method() -> void:
\tpass
`,
    );
    writeFileSync(
      join(root, "scripts", "snippet_caller.gd"),
      `extends Node
class_name SnippetCaller

func call_it() -> void:
\ttarget_method()
`,
    );
    const result = indexGodotProject(root);
    expect(result.ok).toBe(true);

    const graph = createGraphDatabase(root);
    try {
      const callers = getCallersContext(graph, {
        projectRoot: root,
        symbol: "target_method",
        includeCode: true,
        maxFiles: 8,
      });
      const manyLinesSnippet = callers.snippets.find(
        (snippet) => snippet.filePath === "res://scripts/many_lines.gd",
      );

      expect(manyLinesSnippet).toEqual(expect.objectContaining({ startLine: 1 }));
      expect(manyLinesSnippet?.text).not.toContain("func target_method");
    } finally {
      graph.close();
    }
  });
});
