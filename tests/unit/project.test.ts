import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { detectGodotProject } from "../../src/project.js";

const tempRoots: string[] = [];

function createTempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "gdgraph-project-"));
  tempRoots.push(root);
  return root;
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
});

describe("detectGodotProject", () => {
  it("returns the root and project.godot path when the project file exists", () => {
    const root = createTempRoot();
    writeFileSync(join(root, "project.godot"), "[application]\nconfig/name=\"Fixture\"\n");

    expect(detectGodotProject(root)).toEqual({
      ok: true,
      root,
      projectFilePath: join(root, "project.godot"),
    });
  });

  it("returns a clear status for non-Godot directories", () => {
    const root = createTempRoot();
    mkdirSync(join(root, "scripts"));

    expect(detectGodotProject(root)).toEqual({
      ok: false,
      root,
      reason: "missing_project_godot",
      message: `No project.godot found in ${root}`,
    });
  });
});
