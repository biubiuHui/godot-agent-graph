import { installCodexTarget, uninstallCodexTarget } from "./targets/codex.js";
import { installClaudeTarget, uninstallClaudeTarget } from "./targets/claude.js";
import { installCursorTarget, uninstallCursorTarget } from "./targets/cursor.js";
import { installGeminiTarget, uninstallGeminiTarget } from "./targets/gemini.js";
import { installKiroTarget, uninstallKiroTarget } from "./targets/kiro.js";
import { installOpencodeTarget, uninstallOpencodeTarget } from "./targets/opencode.js";
import {
  type ConcreteInstallerTarget,
  installerOk,
  type InstallerOptions,
  type InstallerResult,
  type InstallerTarget,
  type InstallerTargetOptions,
  type InstallerTargetResult,
  normalizeInstallerOptions,
} from "./targets/shared.js";

export type { InstallerOptions, InstallerResult, InstallerTarget } from "./targets/shared.js";

export function installGdgraphMcp(options: InstallerOptions = {}): InstallerResult {
  const normalized = normalizeInstallerOptions(options);
  const results = selectedTargets(options.target).map((target) => installTarget(target, normalized));

  return {
    ok: installerOk(results),
    results,
    verificationHints: [
      "Restart the target Agent after installation.",
      "In Codex, run /mcp or inspect MCP settings to confirm godot-agent-graph is available.",
    ],
  };
}

export function uninstallGdgraphMcp(options: InstallerOptions = {}): InstallerResult {
  const normalized = normalizeInstallerOptions(options);
  const results = selectedTargets(options.target).map((target) => uninstallTarget(target, normalized));

  return {
    ok: installerOk(results),
    results,
    verificationHints: [
      "Restart the target Agent after uninstalling.",
      "Confirm godot-agent-graph no longer appears in the target Agent MCP server list.",
    ],
  };
}

function selectedTargets(target: InstallerTarget = "all"): ConcreteInstallerTarget[] {
  if (target === "all") {
    return ["codex", "claude", "cursor", "opencode", "gemini", "kiro"];
  }

  return [target];
}

function installTarget(
  target: ConcreteInstallerTarget,
  normalized: InstallerTargetOptions,
): InstallerTargetResult {
  switch (target) {
    case "codex":
      return installCodexTarget(normalized);
    case "claude":
      return installClaudeTarget(normalized);
    case "cursor":
      return installCursorTarget(normalized);
    case "opencode":
      return installOpencodeTarget(normalized);
    case "gemini":
      return installGeminiTarget(normalized);
    case "kiro":
      return installKiroTarget(normalized);
  }
}

function uninstallTarget(
  target: ConcreteInstallerTarget,
  normalized: InstallerTargetOptions,
): InstallerTargetResult {
  switch (target) {
    case "codex":
      return uninstallCodexTarget(normalized);
    case "claude":
      return uninstallClaudeTarget(normalized);
    case "cursor":
      return uninstallCursorTarget(normalized);
    case "opencode":
      return uninstallOpencodeTarget(normalized);
    case "gemini":
      return uninstallGeminiTarget(normalized);
    case "kiro":
      return uninstallKiroTarget(normalized);
  }
}
