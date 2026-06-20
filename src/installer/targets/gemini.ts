import { type InstallerTargetOptions, type InstallerTargetResult } from "./shared.js";
import {
  installJsonMcpTarget,
  projectConfigPath,
  uninstallJsonMcpTarget,
} from "./json-mcp.js";

const GEMINI_TARGET = {
  target: "gemini" as const,
  displayName: "Gemini",
  configPath: (options: InstallerTargetOptions) => projectConfigPath(options, ".gemini", "settings.json"),
};

export function installGeminiTarget(options: InstallerTargetOptions): InstallerTargetResult {
  return installJsonMcpTarget(options, GEMINI_TARGET);
}

export function uninstallGeminiTarget(options: InstallerTargetOptions): InstallerTargetResult {
  return uninstallJsonMcpTarget(options, GEMINI_TARGET);
}
