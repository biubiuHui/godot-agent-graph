import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { parseGdscript } from "../../../src/parsers/gdscript.js";

const fixturesRoot = fileURLToPath(new URL("../../fixtures/godot", import.meta.url));

function readFixture(relativePath: string): string {
  return readFileSync(join(fixturesRoot, relativePath), "utf8");
}

describe("parseGdscript", () => {
  it("parses script identity and methods", () => {
    const result = parseGdscript(
      readFixture("minimal/scripts/fixture_actor.gd"),
      "res://scripts/fixture_actor.gd",
    );

    expect(result.extendsName).toBe("CharacterBody2D");
    expect(result.className).toEqual({ name: "FixtureActor", line: 2 });
    expect(result.methods).toEqual([
      {
        name: "_ready",
        ownerName: null,
        static: false,
        line: 4,
        signature: "func _ready() -> void:",
      },
    ]);
    expect(result.errors).toEqual([]);
  });

  it("parses signal declarations, emits, connects, and method calls", () => {
    const result = parseGdscript(
      readFixture("signals/scripts/signal_demo.gd"),
      "res://scripts/signal_demo.gd",
    );

    expect(result.signals).toEqual([{ name: "health_depleted", ownerName: null, line: 4 }]);
    expect(result.signalConnects).toMatchObject([
      {
        signalName: "health_depleted",
        target: "_on_health_depleted",
        line: 7,
      },
    ]);
    expect(result.signalEmits).toMatchObject([
      {
        signalName: "health_depleted",
        line: 10,
      },
    ]);
    expect(result.calls.map((call) => [call.name, call.line])).toEqual([
      ["damage", 16],
    ]);
  });

  it("parses callable and bound signal connection targets", () => {
    const result = parseGdscript(
      `extends Node
signal selected

func _ready() -> void:
\tselected.connect(Callable(self, "_on_selected"))
\tbutton.pressed.connect(_on_pressed.bind(button))
\tconnect("tree_exiting", Callable(self, "_on_tree_exiting"))
\tvar selected_callable := Callable(self, "_on_selected_again")
\tselected.connect(selected_callable)
`,
      "res://scripts/connect_targets.gd",
    );

    expect(result.signalConnects).toMatchObject([
      {
        signalName: "selected",
        target: "_on_selected",
        line: 5,
      },
      {
        signalName: "pressed",
        target: "_on_pressed",
        line: 6,
      },
      {
        signalName: "tree_exiting",
        target: "_on_tree_exiting",
        line: 7,
      },
      {
        signalName: "selected",
        target: "_on_selected_again",
        line: 9,
      },
    ]);
  });

  it("filters built-in signal emits unless declared locally", () => {
    const result = parseGdscript(
      `extends Node
signal pressed

func _ready() -> void:
\tpressed.emit()
\tbutton.pressed.emit()
\temit_signal("mouse_entered")
`,
      "res://scripts/signal_emit_filter.gd",
    );

    expect(result.signalEmits).toMatchObject([
      {
        signalName: "pressed",
        line: 5,
      },
    ]);
  });

  it("records call receivers for qualified calls", () => {
    const result = parseGdscript(
      `extends Node

func _ready() -> void:
\tFixtureEvent.create("night_start")
\tFileAccess.open("user://save.json", FileAccess.READ)
\tDirAccess.open("res://")
\tscreen.open({})
\tfixture_state.grid_state.get_item(Vector2i.ZERO)
\tnight_color.lerp(dawn_color, t).lerp(day_color, t)
\tlocal_helper()
`,
      "res://scripts/call_receivers.gd",
    );

    expect(result.calls).toMatchObject([
      {
        name: "create",
        receiver: "FixtureEvent",
        line: 4,
      },
      {
        name: "open",
        receiver: "screen",
        line: 7,
      },
      {
        name: "get_item",
        receiver: "fixture_state.grid_state",
        line: 8,
      },
      {
        name: "lerp",
        receiver: "night_color",
        line: 9,
      },
      {
        name: "local_helper",
        receiver: null,
        line: 10,
      },
    ]);
  });

  it("parses load and preload resource references", () => {
    const result = parseGdscript(
      readFixture("resources/scripts/resource_user.gd"),
      "res://scripts/resource_user.gd",
    );

    expect(result.resourceRefs).toMatchObject([
      {
        kind: "preload",
        path: "res://resources/fixture_stats.tres",
        line: 3,
      },
      {
        kind: "load",
        path: "res://resources/fixture_stats.tres",
        line: 6,
      },
    ]);
  });

  it("parses input actions and autoload candidates", () => {
    const result = parseGdscript(
      readFixture("autoload-input/scripts/fixture_input.gd"),
      "res://scripts/fixture_input.gd",
    );

    expect(result.inputActions).toMatchObject([
      {
        name: "move_left",
        line: 4,
      },
    ]);
    expect(result.autoloadCandidates).toMatchObject([
      {
        name: "FixtureState",
        line: 5,
      },
      {
        name: "FixtureState",
        line: 6,
      },
      {
        name: "FixtureState",
        line: 7,
      },
      {
        name: "FixtureSaveService",
        line: 8,
      },
    ]);
  });

  it("parses properties, inner classes, static methods, and node references", () => {
    const result = parseGdscript(
      `extends Node
class_name Utility

signal ready_changed

@export var speed := 10
const DEFAULT_NAME := "FixtureActor"

class Helper:
\tvar value := 1

static func build() -> void:
\t$Camera.enabled = true
\tget_node("UI/Button").grab_focus()
\tscreen.get_node_or_null("RootLayout/CenterColumn/ContentPanel")
\tget_node_or_null("/root/FixtureState")
\tget_tree().root.get_node_or_null("FixtureSaveService")
\t%HealthBar.value = 10
\tready_changed.emit()
`,
      "res://scripts/utility.gd",
    );

    expect(
      result.properties.map((property) => [
        property.name,
        property.ownerName,
        property.kind,
        property.exported,
      ]),
    ).toEqual([
      ["speed", null, "var", true],
      ["DEFAULT_NAME", null, "const", false],
      ["value", "Helper", "var", false],
    ]);
    expect(result.innerClasses).toEqual([{ name: "Helper", line: 9 }]);
    expect(result.methods).toEqual([
      {
        name: "build",
        ownerName: null,
        static: true,
        line: 12,
        signature: "static func build() -> void:",
      },
    ]);
    expect(result.nodeRefs).toMatchObject([
      {
        kind: "dollar",
        path: "Camera",
        line: 13,
      },
      {
        kind: "get_node",
        path: "UI/Button",
        line: 14,
        receiver: null,
      },
      {
        kind: "get_node",
        path: "RootLayout/CenterColumn/ContentPanel",
        line: 15,
        receiver: "screen",
      },
      {
        kind: "root_get_node",
        path: "/root/FixtureState",
        line: 16,
      },
      {
        kind: "root_get_node",
        path: "FixtureSaveService",
        line: 17,
      },
      {
        kind: "unique",
        path: "HealthBar",
        line: 18,
      },
    ]);
    expect(result.signalEmits).toMatchObject([
      {
        signalName: "ready_changed",
        line: 19,
      },
    ]);
    expect(result.autoloadCandidates).toMatchObject([
      {
        name: "FixtureState",
        line: 16,
      },
      {
        name: "FixtureSaveService",
        line: 17,
      },
    ]);
  });

  it("accepts Godot 4 unique node shorthand after dollar node access", () => {
    const result = parseGdscript(
      `extends Control

@onready var dish_icon: TextureRect = $%DishIcon

func _ready() -> void:
\t$%CookButton.pressed.connect(_on_cook_pressed)
`,
      "res://scenes/ui/cell_item.gd",
    );

    expect(result.errors).toEqual([]);
    expect(result.nodeRefs).toMatchObject([
      {
        kind: "unique",
        path: "DishIcon",
        line: 3,
      },
      {
        kind: "unique",
        path: "CookButton",
        line: 6,
      },
    ]);
  });

  it("does not collect references from strings or inline comments", () => {
    const result = parseGdscript(
      `extends Node

func _ready() -> void:
\tprint("FixtureSaveService.save() Input.is_action_pressed(\\"jump\\") health_depleted.emit()")
\tvar label := "FixtureState.advance_night()"
\t# FixtureSaveService.save()
\tprint("ok") # FixtureState.advance_night()
\tvar scene := preload("res://scenes/fixture_main.tscn")
\tif Input.is_action_pressed("jump"):
\t\tget_node("UI/Button").grab_focus()
`,
      "res://scripts/comment_demo.gd",
    );

    expect(result.autoloadCandidates).toMatchObject([]);
    expect(result.signalEmits).toMatchObject([]);
    expect(result.resourceRefs).toMatchObject([
      {
        kind: "preload",
        path: "res://scenes/fixture_main.tscn",
        line: 8,
      },
    ]);
    expect(result.inputActions).toMatchObject([
      {
        name: "jump",
        line: 9,
      },
    ]);
    expect(result.nodeRefs).toMatchObject([
      {
        kind: "get_node",
        path: "UI/Button",
        line: 10,
        receiver: null,
      },
    ]);
    expect(result.calls).toMatchObject([]);
  });

  it("ignores common Godot built-in calls while keeping project helper calls", () => {
    const result = parseGdscript(
      `extends Node
signal pressed(position: Vector2i)
@export_enum("a", "b") var mode := "a"

func _ready() -> void:
\tif not is_inside_tree():
\t\treturn
\tvar scene := preload("res://ui/popup.tscn")
\tvar popup := scene.instantiate()
\tadd_child(popup)
\tpopup.queue_free()
\tset_process(false)
\tvar tree := get_tree()
\tvar parent := get_parent()
\tvar text := ",".join(["a", "b"])
\tvar text_len := text.length()
\tif text.contains("a") and text.begins_with("a"):
\t\tvar roll := rng.randi_range(1, 3)
\t\tvar float_roll := rng.randf()
\t\tvar int_roll := rng.randi()
\t\tvar chance := clampf(float_roll, 0.0, 1.0)
\t\tpayload.merge({"roll": roll}, true)
\t\tpayload.erase("old_roll")
\t\tbackground.add_theme_stylebox_override("panel", style)
\t\tvalues.append_array([int_roll])
\t\tvalues.resize(3)
\t\tvalues.remove_at(0)
\t\tvar raw := FileAccess.get_file_as_string("res://data.json")
\t\tvar encoded := JSON.stringify(payload)
\t\tvar parsed := JSON.parse_string(encoded)
\t\tvar suffix_ok := raw.ends_with("}")
\t\tvar trimmed := raw.trim_prefix("data:")
\t\tvar piece := raw.substr(0, text_len)
\t\tvar child_path := "res://".path_join("data.json")
\t\tvar can_open := ResourceLoader.exists(child_path) or suffix_ok
\t\tif can_open and parsed != null:
\t\t\tpass
\t\tvar tween := create_tween()
\t\ttween.tween_property(self, "modulate:a", chance, 0.2).set_trans(Tween.TRANS_SINE).set_ease(Tween.EASE_OUT)
\t\tfor child in get_children():
\t\t\tchild.get_property_list()
\t\tdir.list_dir_begin()
\t\tvar next_file := dir.get_next()
\t\tdir.list_dir_end()
\t\tif has_signal("pressed") and next_file.is_empty():
\t\t\taccept_event()
\t\tProjectSettings.get_setting("display/window/size/viewport_width", 0)
\t\tcallback.bind(payload)
\t\ttween.parallel()
\t\tstyle.set_corner_radius_all(4)
\t\tstyle.set_border_width_all(1)
\t\tlabel.add_theme_color_override("font_color", Color.WHITE)
\t\tlabel.add_theme_font_size_override("font_size", 12)
\t\tdir.current_is_dir()
\t\tfloor(1.2)
\t\tfile.get_as_text()
\t\tanchor_rect.get_center()
\t\tcontrol.get_global_rect()
\t\tEngine.get_main_loop()
\t\t"12".is_valid_int()
\t\tabsf(-1.0)
\t\tclampi(4, 0, 10)
\t\tposition.distance_to(Vector2.ZERO)
\t\tFileAccess.file_exists("user://save.json")
\t\tforce_drag(payload, preview)
\t\tresource.get_class()
\t\tcontrol.get_combined_minimum_size()
\t\tobject.get_method_list()
\t\tcontrol.get_theme_constant("separation")
\t\tlabel.get_theme_font_size("font_size")
\t\tget_viewport()
\t\tget_viewport_rect()
\t\tProjectSettings.globalize_path("res://")
\t\tlabel.has_theme_font_size_override("font_size")
\t\tvalues.insert(0, "x")
\t\tis_equal_approx(1.0, 1.0)
\t\tVector2.RIGHT.normalized()
\t\tqueue_redraw()
\t\trng.randomize()
\t\t"old-name".replace("-", "_")
\t\tset_drag_preview(preview)
\t\t"one\\ntwo".split("\\n")
\t\t"seed".to_utf8_buffer()
\t\tceil(1.2)
\t\tDirAccess.dir_exists_absolute("/tmp")
\t\t"path/file.txt".get_base_dir()
\t\tOS.get_cmdline_user_args()
\t\tscript.get_script_method_list()
\t\tpanel.get_theme_stylebox("panel")
\t\tTime.get_ticks_usec()
\t\tviewport.gui_get_drag_data()
\t\t"abc".to_utf8_buffer().hex_encode()
\t\ttween.is_valid()
\t\tcontrol.is_visible_in_tree()
\t\tis_zero_approx(0.0)
\t\tfill.lightened(0.25)
\t\tDirAccess.make_dir_recursive_absolute("/tmp/gdgraph")
\t\tposmod(-1, 10)
\t\troundf(1.2)
\t\troundi(1.2)
\t\trandf_range(0.0, 1.0)
\t\tsin(0.5)
\t\tcos(0.5)
\t\tpow(2.0, 3.0)
\t\tseed(123)
\t\tlerpf(0.0, 1.0, 0.5)
\t\tdraw_line(Vector2.ZERO, Vector2.ONE, Color.WHITE)
\t\tdraw_arc(Vector2.ZERO, 5.0, 0.0, 1.0, 8, Color.WHITE)
\t\tdraw_circle(Vector2.ZERO, 5.0, Color.WHITE)
\t\tdraw_rect(Rect2(Vector2.ZERO, Vector2.ONE), Color.WHITE)
\t\tmaterial.set_shader_parameter("alpha", 1.0)
\t\tscript.get_script()
\t\toffset.length_squared()
\t\toffset.rotated(0.25)
\t\toffset.dot(Vector2.RIGHT)
\t\t@export_range(0, 10) var exported_range := 5
\t\t@export_group("Debug")
\t\tviewport.set_input_as_handled()
\t\titems.slice(1)
\t\tfile.store_line("x")
\t\tfile.store_string("x")
\t\ttween.tween_interval(0.1)
\t\tif button.pressed.is_connected(_project_helper):
\t\t\tbutton.pressed.disconnect(_project_helper)
\t\tremove_child(popup)
\t\tget_tree().quit()
\tsuper()
\treturn (payload as Dictionary).duplicate(true)

func _tick() -> void:
\t_project_helper()
`,
      "res://scripts/builtin_calls.gd",
    );

    expect(result.calls.map((call) => [call.name, call.receiver])).toEqual([
      ["_project_helper", null],
    ]);
  });

  it("does not parse local function variables as script properties", () => {
    const result = parseGdscript(
      `extends Node

var top_level := 1

func _ready() -> void:
\tvar local_value := 2
\tconst LOCAL_CONST := 3
\tif true:
\t\tvar nested_value := 4

class Helper:
\tvar member_value := 5
\tfunc build() -> void:
\t\tvar helper_local := 6
`,
      "res://scripts/local_variables.gd",
    );

    expect(result.methods.map((method) => [method.name, method.ownerName, method.line])).toEqual([
      ["_ready", null, 5],
      ["build", "Helper", 13],
    ]);
    expect(result.properties.map((property) => [property.name, property.ownerName, property.line])).toEqual([
      ["top_level", null, 3],
      ["member_value", "Helper", 12],
    ]);
  });

  it("keeps multiline function body variables out of script properties", () => {
    const result = parseGdscript(
      `extends RefCounted
class_name Factory

var top_level := 1

static func create_item(
\titem_id: String = "",
\tposition: Vector2i = Vector2i.ZERO
) -> Dictionary:
\tvar result := {}
\tvar fixture_data := null
\tresult["id"] = item_id
\treturn result
`,
      "res://scripts/factory.gd",
    );

    expect(result.methods.map((method) => [method.name, method.line])).toEqual([
      ["create_item", 6],
    ]);
    expect(result.properties.map((property) => [property.name, property.line])).toEqual([
      ["top_level", 4],
    ]);
    expect(result.calls.map((call) => [call.name, call.line])).toEqual([]);
  });

  it("does not crash tree-sitter syntax validation on scripts larger than 32 KiB", () => {
    const largeScript = `extends Node\n${Array.from(
      { length: 1500 },
      (_, index) => `func generated_${index}() -> void:\n\tpass\n`,
    ).join("\n")}`;

    expect(largeScript.length).toBeGreaterThan(32 * 1024);
    expect(() => parseGdscript(largeScript, "res://scripts/generated_large.gd")).not.toThrow();
  });
});
