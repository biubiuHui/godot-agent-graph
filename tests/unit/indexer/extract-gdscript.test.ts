import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { extractGdscriptGraph } from "../../../src/indexer/extract-gdscript.js";
import { parseGdscript } from "../../../src/parsers/gdscript.js";

const fixturesRoot = fileURLToPath(new URL("../../fixtures/godot", import.meta.url));

function parseFixture(relativePath: string, resPath: string) {
  return parseGdscript(readFileSync(join(fixturesRoot, relativePath), "utf8"), resPath);
}

describe("extractGdscriptGraph", () => {
  it("creates script class and method records", () => {
    const graph = extractGdscriptGraph(
      parseFixture("minimal/scripts/fixture_actor.gd", "res://scripts/fixture_actor.gd"),
      { updatedAt: 1000 },
    );

    expect(graph.nodes.map((node) => [node.id, node.kind, node.name])).toEqual([
      ["script:res://scripts/fixture_actor.gd", "script_class", "FixtureActor"],
      ["method:res://scripts/fixture_actor.gd:_ready", "method", "_ready"],
    ]);
    expect(graph.edges.map((edge) => [edge.source, edge.target, edge.kind])).toEqual([
      ["script:res://scripts/fixture_actor.gd", "method:res://scripts/fixture_actor.gd:_ready", "contains"],
    ]);
    expect(graph.unresolvedRefs).toEqual([]);
  });

  it("extracts signal, emit, connect, and call unresolved refs", () => {
    const graph = extractGdscriptGraph(
      parseFixture("signals/scripts/signal_demo.gd", "res://scripts/signal_demo.gd"),
      { updatedAt: 2000 },
    );

    expect(graph.nodes.map((node) => [node.id, node.kind, node.name])).toEqual([
      ["script:res://scripts/signal_demo.gd", "script_class", "SignalDemo"],
      ["method:res://scripts/signal_demo.gd:_on_health_depleted", "method", "_on_health_depleted"],
      ["method:res://scripts/signal_demo.gd:_on_start_button_pressed", "method", "_on_start_button_pressed"],
      ["method:res://scripts/signal_demo.gd:_ready", "method", "_ready"],
      ["method:res://scripts/signal_demo.gd:damage", "method", "damage"],
      ["signal:res://scripts/signal_demo.gd:health_depleted", "signal", "health_depleted"],
    ]);
    expect(graph.unresolvedRefs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          referenceName: "health_depleted",
          referenceKind: "connects_signal",
          candidates: expect.arrayContaining([
            expect.objectContaining({
              target: "_on_health_depleted",
            }),
          ]),
        }),
        expect.objectContaining({
          referenceName: "health_depleted",
          referenceKind: "emits_signal",
        }),
        expect.objectContaining({
          referenceName: "damage",
          referenceKind: "calls",
        }),
      ]),
    );
  });

  it("extracts resource load references", () => {
    const graph = extractGdscriptGraph(
      parseFixture("resources/scripts/resource_user.gd", "res://scripts/resource_user.gd"),
      { updatedAt: 3000 },
    );

    expect(graph.unresolvedRefs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          referenceName: "res://resources/fixture_stats.tres",
          referenceKind: "preloads_resource",
        }),
        expect.objectContaining({
          referenceName: "res://resources/fixture_stats.tres",
          referenceKind: "loads_resource",
        }),
      ]),
    );
  });

  it("extracts input action and autoload candidate references", () => {
    const graph = extractGdscriptGraph(
      parseFixture("autoload-input/scripts/fixture_input.gd", "res://scripts/fixture_input.gd"),
      { updatedAt: 4000 },
    );

    expect(graph.unresolvedRefs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          referenceName: "move_left",
          referenceKind: "uses_input_action",
        }),
        expect.objectContaining({
          referenceName: "FixtureState",
          referenceKind: "uses_autoload",
        }),
      ]),
    );
  });

  it("extracts property, inner class, signal, and nodepath records", () => {
    const graph = extractGdscriptGraph(
      parseGdscript(
        `extends Node
class_name Utility
signal ready_changed
@export var speed := 10
const DEFAULT_NAME := "FixtureActor"
class Helper:
\tpass
func _ready() -> void:
\t$Camera.enabled = true
\tget_node("UI/Button").grab_focus()
\t%HealthBar.value = 10
`,
        "res://scripts/utility.gd",
      ),
      { updatedAt: 5000 },
    );

    expect(graph.nodes.map((node) => [node.id, node.kind, node.name])).toEqual([
      ["script:res://scripts/utility.gd", "script_class", "Utility"],
      ["inner_class:res://scripts/utility.gd:Helper", "inner_class", "Helper"],
      ["method:res://scripts/utility.gd:_ready", "method", "_ready"],
      ["property:res://scripts/utility.gd:DEFAULT_NAME", "property", "DEFAULT_NAME"],
      ["property:res://scripts/utility.gd:speed", "property", "speed"],
      ["signal:res://scripts/utility.gd:ready_changed", "signal", "ready_changed"],
    ]);
    expect(graph.unresolvedRefs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          referenceName: "Camera",
          referenceKind: "references_nodepath",
        }),
        expect.objectContaining({
          referenceName: "UI/Button",
          referenceKind: "references_nodepath",
        }),
        expect.objectContaining({
          referenceName: "HealthBar",
          referenceKind: "references_nodepath",
        }),
      ]),
    );
  });

  it("filters receiver builtin calls while keeping local calls with the same names", () => {
    const graph = extractGdscriptGraph(
      parseGdscript(
        `extends Node
func _ready() -> void:
\tids.find("route")
\tcontext.update(PackedByteArray())
\tcontext.finish()
\ttween.kill()
\tfind()
\tupdate()
\tfinish()
\tkill()
`,
        "res://scripts/builtin_receiver_calls.gd",
      ),
      { updatedAt: 5500 },
    );

    const calls = graph.unresolvedRefs
      .filter((ref) => ref.referenceKind === "calls")
      .map((ref) => [ref.referenceName, ref.candidates]);

    expect(calls).toEqual([
      ["find", []],
      ["update", []],
      ["finish", []],
      ["kill", []],
    ]);
  });

  it("anchors method body references to the containing method", () => {
    const graph = extractGdscriptGraph(
      parseGdscript(
        `extends Node
class_name RefOwner

func _ready() -> void:
\thelper()

func helper() -> void:
\tpass
`,
        "res://scripts/ref_owner.gd",
      ),
      { updatedAt: 5600 },
    );

    expect(graph.unresolvedRefs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          fromNodeId: "method:res://scripts/ref_owner.gd:_ready",
          referenceName: "helper",
          referenceKind: "calls",
        }),
      ]),
    );
    expect(graph.unresolvedRefs).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          fromNodeId: "script:res://scripts/ref_owner.gd",
          referenceName: "helper",
          referenceKind: "calls",
        }),
      ]),
    );
  });

  it("extracts ordinary symbol read unresolved refs", () => {
    const graph = extractGdscriptGraph(
      parseGdscript(
        `extends Node
class_name SymbolReadUser

const DEFAULT_LIMIT := 3

func play(catalog: StepCatalog) -> void:
\tif StepCatalog.FIXTURE_STEP_NAME == DEFAULT_LIMIT:
\t\tcatalog.current_step = StepCatalog.FIXTURE_STEP_NAME
`,
        "res://scripts/symbol_read_user.gd",
      ),
      { updatedAt: 5700 },
    );

    expect(graph.unresolvedRefs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          fromNodeId: "method:res://scripts/symbol_read_user.gd:play",
          referenceName: "FIXTURE_STEP_NAME",
          referenceKind: "references_symbol",
          candidates: [{ receiver: "StepCatalog" }],
        }),
        expect.objectContaining({
          fromNodeId: "method:res://scripts/symbol_read_user.gd:play",
          referenceName: "DEFAULT_LIMIT",
          referenceKind: "references_symbol",
          candidates: [],
        }),
        expect.objectContaining({
          fromNodeId: "method:res://scripts/symbol_read_user.gd:play",
          referenceName: "current_step",
          referenceKind: "references_symbol",
          candidates: [{ receiver: "catalog" }],
        }),
      ]),
    );
  });

  it("disambiguates duplicate member names in the same script file", () => {
    const graph = extractGdscriptGraph(
      parseGdscript(
        `extends RefCounted
class_name Snapshot

class Cell:
\tvar disabled_reason := ""
\tfunc _init() -> void:
\t\tpass

class Slot:
\tvar disabled_reason := ""
\tfunc _init() -> void:
\t\tpass
`,
        "res://scripts/snapshot.gd",
      ),
      { updatedAt: 6000 },
    );

    expect(graph.nodes.map((node) => [node.id, node.kind, node.name])).toEqual([
      ["script:res://scripts/snapshot.gd", "script_class", "Snapshot"],
      ["inner_class:res://scripts/snapshot.gd:Cell", "inner_class", "Cell"],
      ["inner_class:res://scripts/snapshot.gd:Slot", "inner_class", "Slot"],
      ["method:res://scripts/snapshot.gd:Cell._init", "method", "_init"],
      ["method:res://scripts/snapshot.gd:Slot._init", "method", "_init"],
      ["property:res://scripts/snapshot.gd:Cell.disabled_reason", "property", "disabled_reason"],
      ["property:res://scripts/snapshot.gd:Slot.disabled_reason", "property", "disabled_reason"],
    ]);
    expect(graph.edges.map((edge) => [edge.source, edge.target, edge.kind])).toEqual([
      ["script:res://scripts/snapshot.gd", "inner_class:res://scripts/snapshot.gd:Cell", "contains"],
      ["script:res://scripts/snapshot.gd", "inner_class:res://scripts/snapshot.gd:Slot", "contains"],
      [
        "inner_class:res://scripts/snapshot.gd:Cell",
        "method:res://scripts/snapshot.gd:Cell._init",
        "contains",
      ],
      [
        "inner_class:res://scripts/snapshot.gd:Slot",
        "method:res://scripts/snapshot.gd:Slot._init",
        "contains",
      ],
      [
        "inner_class:res://scripts/snapshot.gd:Cell",
        "property:res://scripts/snapshot.gd:Cell.disabled_reason",
        "contains",
      ],
      [
        "inner_class:res://scripts/snapshot.gd:Slot",
        "property:res://scripts/snapshot.gd:Slot.disabled_reason",
        "contains",
      ],
    ]);
    expect(graph.nodes.map((node) => [node.id, node.qualifiedName])).toEqual([
      ["script:res://scripts/snapshot.gd", "Snapshot"],
      ["inner_class:res://scripts/snapshot.gd:Cell", "Snapshot.Cell"],
      ["inner_class:res://scripts/snapshot.gd:Slot", "Snapshot.Slot"],
      ["method:res://scripts/snapshot.gd:Cell._init", "Snapshot.Cell._init"],
      ["method:res://scripts/snapshot.gd:Slot._init", "Snapshot.Slot._init"],
      ["property:res://scripts/snapshot.gd:Cell.disabled_reason", "Snapshot.Cell.disabled_reason"],
      ["property:res://scripts/snapshot.gd:Slot.disabled_reason", "Snapshot.Slot.disabled_reason"],
    ]);
  });
});
