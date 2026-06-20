import { type InstallerTargetOptions, type InstallerTargetResult } from "./shared.js";
import {
  installJsonMcpTarget,
  projectConfigPath,
  uninstallJsonMcpTarget,
} from "./json-mcp.js";

const KIRO_TARGET = {
  target: "kiro" as const,
  displayName: "Kiro",
  configPath: (options: InstallerTargetOptions) =>
    projectConfigPath(options, ".kiro", "settings", "mcp.json"),
};

export function installKiroTarget(options: InstallerTargetOptions): InstallerTargetResult {
  return installJsonMcpTarget(options, KIRO_TARGET);
}

export function uninstallKiroTarget(options: InstallerTargetOptions): InstallerTargetResult {
  return uninstallJsonMcpTarget(options, KIRO_TARGET);
}
