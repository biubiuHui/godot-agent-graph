import { type InstallerTargetOptions, type InstallerTargetResult } from "./shared.js";
import {
  installJsonMcpTarget,
  projectConfigPath,
  uninstallJsonMcpTarget,
} from "./json-mcp.js";

const CURSOR_TARGET = {
  target: "cursor" as const,
  displayName: "Cursor",
  configPath: (options: InstallerTargetOptions) => projectConfigPath(options, ".cursor", "mcp.json"),
};

export function installCursorTarget(options: InstallerTargetOptions): InstallerTargetResult {
  return installJsonMcpTarget(options, CURSOR_TARGET);
}

export function uninstallCursorTarget(options: InstallerTargetOptions): InstallerTargetResult {
  return uninstallJsonMcpTarget(options, CURSOR_TARGET);
}
