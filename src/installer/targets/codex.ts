import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, win32 } from "node:path";
import { fileURLToPath } from "node:url";

import {
  type InstallerTargetOptions,
  type InstallerTargetResult,
  readTextFile,
  writeTextFile,
} from "./shared.js";

const BEGIN_MARKER = "# godot-agent-graph:begin codex";
const END_MARKER = "# godot-agent-graph:end codex";
const INSTRUCTIONS_BEGIN_MARKER = "<!-- godot-agent-graph:begin codex-instructions -->";
const INSTRUCTIONS_END_MARKER = "<!-- godot-agent-graph:end codex-instructions -->";
const CODEX_SKILL_NAME = "godot-graph-navigation";
const CODEX_SKILL_RELATIVE_DIR = join(".codex", "skills", CODEX_SKILL_NAME);
const CODEX_SKILL_RELATIVE_PATH = join(CODEX_SKILL_RELATIVE_DIR, "SKILL.md");
const SERVER_TABLE = "mcp_servers.godot-agent-graph";
const OWNED_BLOCK_PATTERN = new RegExp(
  `(?:^|\\n)${escapeRegExp(BEGIN_MARKER)}\\n[\\s\\S]*?${escapeRegExp(END_MARKER)}\\n?`,
);
const OWNED_INSTRUCTIONS_PATTERN = new RegExp(
  `(?:^|\\n)${escapeRegExp(INSTRUCTIONS_BEGIN_MARKER)}\\n[\\s\\S]*?${escapeRegExp(INSTRUCTIONS_END_MARKER)}\\n?`,
);
const SERVER_TABLE_PATTERN = /^\[mcp_servers\.(?:"godot-agent-graph"|godot-agent-graph)\]/m;

export function installCodexTarget(options: InstallerTargetOptions): InstallerTargetResult {
  const configPath = codexConfigPath(options.homeDir);
  const current = readTextFile(configPath);
  const block = codexBlock(options);

  if (OWNED_BLOCK_PATTERN.test(current)) {
    writeTextFile(configPath, current.replace(OWNED_BLOCK_PATTERN, `\n${block}`));
    installCodexInstructions(options);
    const skillMessage = installCodexSkill(options);
    return {
      target: "codex",
      action: "installed",
      configPath,
      message: appendMessage("Updated owned gdgraph Codex MCP configuration.", skillMessage),
    };
  }

  if (SERVER_TABLE_PATTERN.test(current)) {
    return {
      target: "codex",
      action: "skipped",
      configPath,
      message: "Skipped Codex config because an unowned godot-agent-graph MCP table already exists.",
    };
  }

  const separator = current.length === 0 ? "" : current.endsWith("\n") ? "\n" : "\n\n";
  writeTextFile(configPath, `${current}${separator}${block}`);
  installCodexInstructions(options);
  const skillMessage = installCodexSkill(options);

  return {
    target: "codex",
    action: "installed",
    configPath,
    message: appendMessage("Installed gdgraph Codex MCP configuration.", skillMessage),
  };
}

export function uninstallCodexTarget(options: InstallerTargetOptions): InstallerTargetResult {
  const configPath = codexConfigPath(options.homeDir);
  const current = readTextFile(configPath);
  const removedInstructions = uninstallCodexInstructions(options);
  const removedSkill = uninstallCodexSkill(options);
  const skillMessage = removedSkill ? "Removed generated gdgraph Codex global skill." : null;

  if (!OWNED_BLOCK_PATTERN.test(current)) {
    return {
      target: "codex",
      action: removedInstructions || removedSkill ? "removed" : "unchanged",
      configPath,
      message: removedInstructions
        ? "Removed owned gdgraph Codex fallback instructions."
        : removedSkill
          ? "Removed generated gdgraph Codex global skill."
        : "No owned gdgraph Codex MCP configuration was found.",
    };
  }

  writeTextFile(configPath, current.replace(OWNED_BLOCK_PATTERN, ""));

  return {
    target: "codex",
    action: "removed",
    configPath,
    message: appendMessage("Removed owned gdgraph Codex MCP configuration.", skillMessage),
  };
}

function codexConfigPath(homeDir: string): string {
  return join(homeDir, ".codex", "config.toml");
}

function codexBlock(options: InstallerTargetOptions): string {
  const launchSpec = codexLaunchSpec(options);

  return `${BEGIN_MARKER}
[${SERVER_TABLE}]
command = ${tomlString(launchSpec.command)}
args = [${launchSpec.args.map(tomlString).join(", ")}]
enabled = true
startup_timeout_sec = 60
${END_MARKER}
`;
}

function installCodexInstructions(options: InstallerTargetOptions): void {
  const instructionsPath = codexInstructionsPath(options.projectRoot);
  const current = readTextFile(instructionsPath);
  const block = codexInstructionsBlock();

  if (OWNED_INSTRUCTIONS_PATTERN.test(current)) {
    writeTextFile(instructionsPath, current.replace(OWNED_INSTRUCTIONS_PATTERN, `\n${block}`));
    return;
  }

  const separator = current.length === 0 ? "" : current.endsWith("\n") ? "\n" : "\n\n";
  writeTextFile(instructionsPath, `${current}${separator}${block}`);
}

function uninstallCodexInstructions(options: InstallerTargetOptions): boolean {
  const instructionsPath = codexInstructionsPath(options.projectRoot);
  const current = readTextFile(instructionsPath);
  if (!OWNED_INSTRUCTIONS_PATTERN.test(current)) {
    return false;
  }

  writeTextFile(instructionsPath, current.replace(OWNED_INSTRUCTIONS_PATTERN, ""));
  return true;
}

function codexInstructionsPath(projectRoot: string): string {
  return join(projectRoot, "AGENTS.md");
}

function installCodexSkill(options: InstallerTargetOptions): string | null {
  if (!options.withSkill) {
    return null;
  }

  const skillPath = codexSkillPath(options.homeDir);
  const skill = bundledCodexSkill();
  const current = readTextFile(skillPath);
  if (current.length > 0 && current !== skill) {
    return "Codex global skill already exists and was left unchanged.";
  }

  const skillDir = codexSkillDir(options.homeDir);
  mkdirSync(dirname(skillDir), { recursive: true });
  cpSync(bundledCodexSkillDir(), skillDir, { recursive: true });
  return "Installed Codex global skill.";
}

function uninstallCodexSkill(options: InstallerTargetOptions): boolean {
  if (!options.withSkill) {
    return false;
  }

  const skillPath = codexSkillPath(options.homeDir);
  if (!existsSync(skillPath)) {
    return false;
  }

  if (!codexSkillDirMatchesBundle(codexSkillDir(options.homeDir))) {
    return false;
  }

  rmSync(codexSkillDir(options.homeDir), { force: true, recursive: true });
  return true;
}

function codexSkillDir(projectRoot: string): string {
  return join(projectRoot, CODEX_SKILL_RELATIVE_DIR);
}

function codexSkillPath(projectRoot: string): string {
  return join(projectRoot, CODEX_SKILL_RELATIVE_PATH);
}

function appendMessage(base: string, detail: string | null): string {
  return detail === null ? base : `${base} ${detail}`;
}

function bundledCodexSkill(): string {
  return readFileSync(join(bundledCodexSkillDir(), "SKILL.md"), "utf8");
}

function bundledCodexSkillDir(): string {
  const moduleDir = dirname(fileURLToPath(import.meta.url));
  const candidatePaths = [
    join(moduleDir, "..", "..", "skills", CODEX_SKILL_NAME),
    join(moduleDir, "..", "..", "..", ".agents", "skills", CODEX_SKILL_NAME),
  ];

  for (const path of candidatePaths) {
    if (existsSync(join(path, "SKILL.md"))) {
      return path;
    }
  }

  throw new Error(`Bundled Codex skill not found: ${CODEX_SKILL_NAME}`);
}

function codexSkillDirMatchesBundle(targetDir: string): boolean {
  if (!existsSync(targetDir)) {
    return false;
  }

  const bundledDir = bundledCodexSkillDir();
  const bundledFiles = listRelativeFiles(bundledDir);
  const targetFiles = listRelativeFiles(targetDir);
  if (bundledFiles.length !== targetFiles.length) {
    return false;
  }

  for (let index = 0; index < bundledFiles.length; index += 1) {
    const file = bundledFiles[index];
    if (file !== targetFiles[index]) {
      return false;
    }

    if (!readFileSync(join(bundledDir, file)).equals(readFileSync(join(targetDir, file)))) {
      return false;
    }
  }

  return true;
}

function listRelativeFiles(root: string): string[] {
  const files: string[] = [];
  const visit = (dir: string): void => {
    for (const entry of readdirSync(dir).sort()) {
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) {
        visit(path);
        continue;
      }
      files.push(relative(root, path));
    }
  };

  visit(root);
  return files.sort();
}

function codexInstructionsBlock(): string {
  return `${INSTRUCTIONS_BEGIN_MARKER}
## Godot Graph Navigation

- For Godot scripts, scenes, resources, signals, node paths, or call chains, use the \`godot-graph-navigation\` skill when available.
- If the skill is unavailable, call \`godot_context\` before broad file search, then use \`godot_node\` for indexed source reads.
- Prefer \`godot_node({ file, symbol })\` by expanding \`context.paths[pN]\` and using the node \`name\` or \`qname\`.
- If the graph is missing or stale, run \`godot_sync\` or \`gdgraph sync <project>\`.
${INSTRUCTIONS_END_MARKER}
`;
}

function codexLaunchSpec(options: InstallerTargetOptions): { command: string; args: string[] } {
  if (options.spec.command !== "gdgraph") {
    return options.spec;
  }

  const binPath = process.argv[1];
  if (!isGdgraphBin(binPath)) {
    return options.spec;
  }

  return {
    command: process.execPath,
    args: [
      isAbsolute(binPath) || win32.isAbsolute(binPath) ? binPath : resolve(binPath),
      ...options.spec.args,
    ],
  };
}

function isGdgraphBin(path: string | undefined): path is string {
  if (!path) {
    return false;
  }

  const name = basename(path);
  const windowsName = win32.basename(path);
  return (
    name === "gdgraph" ||
    name === "gdgraph.js" ||
    windowsName === "gdgraph" ||
    windowsName === "gdgraph.js"
  );
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
