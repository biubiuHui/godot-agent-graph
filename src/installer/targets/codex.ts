import { basename, isAbsolute, join, resolve, win32 } from "node:path";

import {
  type InstallerTargetOptions,
  type InstallerTargetResult,
  readTextFile,
  writeTextFile,
} from "./shared.js";

const BEGIN_MARKER = "# godot-agent-graph:begin codex";
const END_MARKER = "# godot-agent-graph:end codex";
const SERVER_TABLE = "mcp_servers.godot-agent-graph";
const OWNED_BLOCK_PATTERN = new RegExp(
  `(?:^|\\n)${escapeRegExp(BEGIN_MARKER)}\\n[\\s\\S]*?${escapeRegExp(END_MARKER)}\\n?`,
);
const SERVER_TABLE_PATTERN = /^\[mcp_servers\.(?:"godot-agent-graph"|godot-agent-graph)\]/m;

export function installCodexTarget(options: InstallerTargetOptions): InstallerTargetResult {
  const configPath = codexConfigPath(options.homeDir);
  const current = readTextFile(configPath);
  const block = codexBlock(options);

  if (OWNED_BLOCK_PATTERN.test(current)) {
    writeTextFile(configPath, current.replace(OWNED_BLOCK_PATTERN, `\n${block}`));
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

  if (!OWNED_BLOCK_PATTERN.test(current)) {
    return {
      target: "codex",
      action: "unchanged",
      configPath,
      message: "No owned gdgraph Codex MCP configuration was found.",
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
