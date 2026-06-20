import { existsSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

export interface GodotProjectDetected {
  ok: true;
  root: string;
  projectFilePath: string;
}

export interface GodotProjectMissing {
  ok: false;
  root: string;
  reason: "missing_project_godot" | "not_a_directory";
  message: string;
}

export type GodotProjectDetectionResult = GodotProjectDetected | GodotProjectMissing;

export function detectGodotProject(projectRoot: string): GodotProjectDetectionResult {
  const root = resolve(projectRoot);

  if (!existsSync(root) || !statSync(root).isDirectory()) {
    return {
      ok: false,
      root,
      reason: "not_a_directory",
      message: `${root} is not a directory`,
    };
  }

  const projectFilePath = join(root, "project.godot");

  if (!existsSync(projectFilePath) || !statSync(projectFilePath).isFile()) {
    return {
      ok: false,
      root,
      reason: "missing_project_godot",
      message: `No project.godot found in ${root}`,
    };
  }

  return {
    ok: true,
    root,
    projectFilePath,
  };
}
