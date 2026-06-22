import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

describe("repository Godot graph navigation skill", () => {
  const skillPath = join(process.cwd(), ".agents", "skills", "godot-graph-navigation", "SKILL.md");

  it("exists and front-loads graph navigation triggers", () => {
    expect(existsSync(skillPath)).toBe(true);

    const skill = readFileSync(skillPath, "utf8");
    for (const trigger of [
      "inspect",
      "explain",
      "edit",
      "refactor",
      "review",
      "debug",
      "Godot scripts",
      "scenes",
      "resources",
      "signals",
      "autoloads",
      "node paths",
      "call chains",
      "impact",
    ]) {
      expect(skill).toContain(trigger);
    }
    expect(skill).toContain("godot_context");
    expect(skill).toContain("godot_node");
    expect(skill).toContain("godot_sync");
    expect(skill).toContain("gdgraph");
    expect(skill).toContain("broad file search");
  });

  it("does not include obvious local private paths", () => {
    const skill = existsSync(skillPath) ? readFileSync(skillPath, "utf8") : "";

    expect(skill).not.toMatch(/\/Users\/[^/\s]+\/(?!tool_project\/godot-agent-graph-public)/);
    expect(skill).not.toMatch(/[A-Za-z]:\\Users\\/);
    expect(skill).not.toContain(".env");
  });
});
