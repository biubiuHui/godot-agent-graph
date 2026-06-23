import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

describe("repository Godot graph navigation skill", () => {
  const skillDir = join(process.cwd(), ".agents", "skills", "godot-graph-navigation");
  const skillPath = join(skillDir, "SKILL.md");
  const openAiYamlPath = join(skillDir, "agents", "openai.yaml");

  it("exists and front-loads graph navigation triggers", () => {
    expect(existsSync(skillPath)).toBe(true);

    const skill = readFileSync(skillPath, "utf8");
    expect(skill).toMatch(
      /^---\nname: godot-graph-navigation\ndescription: Use when .+\n---\n\n# Godot Graph Navigation/,
    );
    for (const trigger of [
      "inspect",
      "explain",
      "edit",
      "refactor",
      "review",
      "debug",
      "Godot project",
      "scripts",
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
    expect(skill).toContain("terse identifier-heavy keyword queries");
    expect(skill).toContain("Do not write natural-language task instructions");
    expect(skill).toContain("not an intelligent semantic search engine");
    expect(skill).toContain("Verification Boundaries");
    expect(skill).toContain("Privacy");
  });

  it("includes formal OpenAI skill metadata", () => {
    expect(existsSync(openAiYamlPath)).toBe(true);

    const yaml = readFileSync(openAiYamlPath, "utf8");
    expect(yaml).toContain('display_name: "Godot Graph Navigation"');
    expect(yaml).toContain('short_description: "Navigate Godot code with gdgraph indexes"');
    expect(yaml).toContain(
      'default_prompt: "Use $godot-graph-navigation to inspect this Godot project with gdgraph before broad source searches."',
    );
  });

  it("does not include obvious local private paths", () => {
    const skill = existsSync(skillPath) ? readFileSync(skillPath, "utf8") : "";
    const openAiYaml = existsSync(openAiYamlPath) ? readFileSync(openAiYamlPath, "utf8") : "";
    const text = `${skill}\n${openAiYaml}`;

    expect(text).not.toMatch(/\/Users\/[^/\s]+\/(?!tool_project\/godot-agent-graph-public)/);
    expect(text).not.toMatch(/[A-Za-z]:\\Users\\/);
    expect(text).not.toContain(".env");
  });
});
