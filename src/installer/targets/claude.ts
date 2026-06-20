import { join } from "node:path";

import {
  type InstallerTargetOptions,
  type InstallerTargetResult,
  readTextFile,
  writeTextFile,
} from "./shared.js";

interface ClaudeMcpConfig {
  mcpServers?: Record<string, unknown>;
  [key: string]: unknown;
}

export function installClaudeTarget(options: InstallerTargetOptions): InstallerTargetResult {
  const configPath = claudeConfigPath(options.projectRoot);
  const parsed = readClaudeConfig(configPath);
  if (!parsed.ok) {
    return skipped(configPath, "Skipped Claude Code config because .mcp.json is not valid JSON.");
  }

  const config = parsed.config;
  const desired = claudeServerConfig(options);
  const existing = config.mcpServers?.[options.spec.name];

  if (existing !== undefined && !jsonEqual(existing, desired)) {
    return skipped(
      configPath,
      "Skipped Claude Code config because an unowned godot-agent-graph server already exists.",
    );
  }

  config.mcpServers = {
    ...(config.mcpServers ?? {}),
    [options.spec.name]: desired,
  };
  writeTextFile(configPath, `${JSON.stringify(config, null, 2)}\n`);

  return {
    target: "claude",
    action: existing === undefined ? "installed" : "unchanged",
    configPath,
    message: "Installed gdgraph Claude Code MCP configuration.",
  };
}

export function uninstallClaudeTarget(options: InstallerTargetOptions): InstallerTargetResult {
  const configPath = claudeConfigPath(options.projectRoot);
  const parsed = readClaudeConfig(configPath);
  if (!parsed.ok) {
    return skipped(configPath, "Skipped Claude Code config because .mcp.json is not valid JSON.");
  }

  const config = parsed.config;
  const desired = claudeServerConfig(options);
  const existing = config.mcpServers?.[options.spec.name];

  if (existing === undefined) {
    return {
      target: "claude",
      action: "unchanged",
      configPath,
      message: "No gdgraph Claude Code MCP configuration was found.",
    };
  }

  if (!jsonEqual(existing, desired)) {
    return skipped(
      configPath,
      "Skipped Claude Code uninstall because the godot-agent-graph server entry was changed by the user.",
    );
  }

  delete config.mcpServers?.[options.spec.name];
  writeTextFile(configPath, `${JSON.stringify(config, null, 2)}\n`);

  return {
    target: "claude",
    action: "removed",
    configPath,
    message: "Removed gdgraph Claude Code MCP configuration.",
  };
}

function claudeConfigPath(projectRoot: string): string {
  return join(projectRoot, ".mcp.json");
}

function claudeServerConfig(options: InstallerTargetOptions): Record<string, unknown> {
  return {
    type: "stdio",
    command: options.spec.command,
    args: options.spec.args,
  };
}

function readClaudeConfig(
  configPath: string,
): { ok: true; config: ClaudeMcpConfig } | { ok: false } {
  const contents = readTextFile(configPath);
  if (contents.trim().length === 0) {
    return { ok: true, config: {} };
  }

  try {
    const parsed = JSON.parse(contents) as unknown;
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      return { ok: true, config: parsed as ClaudeMcpConfig };
    }
  } catch {
    return { ok: false };
  }

  return { ok: false };
}

function skipped(configPath: string, message: string): InstallerTargetResult {
  return {
    target: "claude",
    action: "skipped",
    configPath,
    message,
  };
}

function jsonEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}
