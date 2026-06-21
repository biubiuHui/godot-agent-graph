import { basename, isAbsolute, join, resolve, win32 } from "node:path";

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
    return {
      target: "codex",
      action: "installed",
      configPath,
      message: "Updated owned gdgraph Codex MCP configuration.",
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

  return {
    target: "codex",
    action: "installed",
    configPath,
    message: "Installed gdgraph Codex MCP configuration.",
  };
}

export function uninstallCodexTarget(options: InstallerTargetOptions): InstallerTargetResult {
  const configPath = codexConfigPath(options.homeDir);
  const current = readTextFile(configPath);
  const removedInstructions = uninstallCodexInstructions(options);

  if (!OWNED_BLOCK_PATTERN.test(current)) {
    return {
      target: "codex",
      action: removedInstructions ? "removed" : "unchanged",
      configPath,
      message: removedInstructions
        ? "Removed owned gdgraph Codex fallback instructions."
        : "No owned gdgraph Codex MCP configuration was found.",
    };
  }

  writeTextFile(configPath, current.replace(OWNED_BLOCK_PATTERN, ""));

  return {
    target: "codex",
    action: "removed",
    configPath,
    message: "Removed owned gdgraph Codex MCP configuration.",
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

function codexInstructionsBlock(): string {
  return `${INSTRUCTIONS_BEGIN_MARKER}
## Godot Graph Navigation

- For Godot scripts, scenes, resources, signals, autoloads, node paths, or call chains, use MCP tool \`godot_context\` before broad file search.
- If the graph is stale or missing, use \`godot_status\` then \`godot_sync\`; without MCP, run \`gdgraph sync <project>\` or \`gdgraph explore <query> --path <project>\`.
- Before edits, refactors, reviews, or debugging changes, use \`godot_impact\` or \`gdgraph impact <target> --path <project>\`.
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
