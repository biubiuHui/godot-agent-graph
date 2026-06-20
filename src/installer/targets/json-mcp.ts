import { join } from "node:path";

import {
  type ConcreteInstallerTarget,
  type InstallerTargetOptions,
  type InstallerTargetResult,
  isRecord,
  jsonEqual,
  readJsonObject,
  standardMcpServerConfig,
  writeJsonObject,
} from "./shared.js";

interface JsonMcpTargetSpec {
  target: ConcreteInstallerTarget;
  displayName: string;
  configPath: (options: InstallerTargetOptions) => string;
  serverConfig?: (options: InstallerTargetOptions) => Record<string, unknown>;
}

export function installJsonMcpTarget(
  options: InstallerTargetOptions,
  spec: JsonMcpTargetSpec,
): InstallerTargetResult {
  const configPath = spec.configPath(options);
  const parsed = readJsonObject(configPath);
  if (!parsed.ok) {
    return skipped(spec, configPath, `Skipped ${spec.displayName} config because it is not valid JSON.`);
  }

  const config = parsed.config;
  const desired = (spec.serverConfig ?? standardMcpServerConfig)(options);
  const servers = isRecord(config.mcpServers) ? config.mcpServers : {};
  const existing = servers[options.spec.name];

  if (existing !== undefined && !jsonEqual(existing, desired)) {
    return skipped(
      spec,
      configPath,
      `Skipped ${spec.displayName} config because an unowned godot-agent-graph server already exists.`,
    );
  }

  config.mcpServers = {
    ...servers,
    [options.spec.name]: desired,
  };
  writeJsonObject(configPath, config);

  return {
    target: spec.target,
    action: existing === undefined ? "installed" : "unchanged",
    configPath,
    message: `Installed gdgraph ${spec.displayName} MCP configuration.`,
  };
}

export function uninstallJsonMcpTarget(
  options: InstallerTargetOptions,
  spec: JsonMcpTargetSpec,
): InstallerTargetResult {
  const configPath = spec.configPath(options);
  const parsed = readJsonObject(configPath);
  if (!parsed.ok) {
    return skipped(spec, configPath, `Skipped ${spec.displayName} config because it is not valid JSON.`);
  }

  const config = parsed.config;
  const desired = (spec.serverConfig ?? standardMcpServerConfig)(options);
  const servers = isRecord(config.mcpServers) ? config.mcpServers : {};
  const existing = servers[options.spec.name];

  if (existing === undefined) {
    return {
      target: spec.target,
      action: "unchanged",
      configPath,
      message: `No gdgraph ${spec.displayName} MCP configuration was found.`,
    };
  }

  if (!jsonEqual(existing, desired)) {
    return skipped(
      spec,
      configPath,
      `Skipped ${spec.displayName} uninstall because the godot-agent-graph server entry was changed by the user.`,
    );
  }

  delete servers[options.spec.name];
  if (Object.keys(servers).length === 0) {
    delete config.mcpServers;
  } else {
    config.mcpServers = servers;
  }
  writeJsonObject(configPath, config);

  return {
    target: spec.target,
    action: "removed",
    configPath,
    message: `Removed gdgraph ${spec.displayName} MCP configuration.`,
  };
}

export function projectConfigPath(options: InstallerTargetOptions, ...parts: string[]): string {
  return join(options.projectRoot, ...parts);
}

function skipped(
  spec: JsonMcpTargetSpec,
  configPath: string,
  message: string,
): InstallerTargetResult {
  return {
    target: spec.target,
    action: "skipped",
    configPath,
    message,
  };
}
