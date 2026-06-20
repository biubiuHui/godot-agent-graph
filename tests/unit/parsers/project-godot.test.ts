import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { parseProjectGodot } from "../../../src/parsers/project-godot.js";

const fixturesRoot = fileURLToPath(new URL("../../fixtures/godot", import.meta.url));

function readFixtureProject(name: string): string {
  return readFileSync(join(fixturesRoot, name, "project.godot"), "utf8");
}

describe("parseProjectGodot", () => {
  it("parses project name and main scene from the minimal fixture", () => {
    const result = parseProjectGodot(
      readFixtureProject("minimal"),
      "res://project.godot",
    );

    expect(result.projectName).toBe("MinimalFixture");
    expect(result.mainScene).toBe("res://fixture_main.tscn");
    expect(result.autoloads).toEqual([]);
    expect(result.inputActions).toEqual([]);
    expect(result.errors).toEqual([]);
  });

  it("parses autoloads and input actions", () => {
    const result = parseProjectGodot(
      readFixtureProject("autoload-input"),
      "res://project.godot",
    );

    expect(result.projectName).toBe("AutoloadInputFixture");
    expect(result.mainScene).toBe("res://fixture_main.tscn");
    expect(result.autoloads).toEqual([
      {
        name: "FixtureState",
        path: "res://scripts/fixture_state.gd",
        singleton: true,
        line: 8,
      },
      {
        name: "FixtureSaveService",
        path: "res://scripts/fixture_save_service.gd",
        singleton: true,
        line: 9,
      },
    ]);
    expect(result.inputActions.map((action) => action.name)).toEqual(["move_left", "confirm"]);
    expect(result.errors).toEqual([]);
  });

  it("skips multiline assignments in non-input sections without parse errors", () => {
    const result = parseProjectGodot(
      `[application]
config/name="FixtureProject"

[file_customization]
folder_colors={
"res://scenes/ui/": "blue"
}

[input]
interact={
"deadzone": 0.2,
"events": []
}
`,
      "res://project.godot",
    );

    expect(result.projectName).toBe("FixtureProject");
    expect(result.inputActions.map((action) => action.name)).toEqual(["interact"]);
    expect(result.errors).toEqual([]);
  });

  it("records malformed assignments without throwing", () => {
    const result = parseProjectGodot("[autoload]\nBrokenAutoload\n", "res://project.godot");

    expect(result.autoloads).toEqual([]);
    expect(result.errors).toEqual([
      {
        line: 2,
        message: "Expected key=value assignment",
      },
    ]);
  });
});
