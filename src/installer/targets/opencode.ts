import { existsSync } from "node:fs";
import { join } from "node:path";

import { applyEdits, modify, parse as parseJsonc, type ParseError } from "jsonc-parser";

import {
  type InstallerTargetOptions,
  type InstallerTargetResult,
  isRecord,
  jsonEqual,
  readTextFile,
  writeTextFile,
} from "./shared.js";

const FORMATTING = { tabSize: 2, insertSpaces: true, eol: "\n" };

export function installOpencodeTarget(options: InstallerTargetOptions): InstallerTargetResult {
  const configPath = opencodeConfigPath(options);
  let text = readTextFile(configPath);
  if (text.trim().length === 0) {
    text = `{\n  "$schema": "https://opencode.ai/config.json"\n}\n`;
  }

  const parsed = parseJsoncObject(text);
  if (!parsed.ok) {
    return skipped(configPath, "Skipped opencode config because it is not valid JSONC.");
  }

  const desired = opencodeServerConfig(options);
  const mcp = isRecord(parsed.config.mcp) ? parsed.config.mcp : {};
  const existing = mcp[options.spec.name];
  if (existing !== undefined && !jsonEqual(existing, desired)) {
    return skipped(configPath, "Skipped opencode config because an unowned godot-agent-graph server already exists.");
  }

  if (!parsed.config.$schema) {
    text = applyEdits(
      text,
      modify(text, ["$schema"], "https://opencode.ai/config.json", {
        formattingOptions: FORMATTING,
      }),
    );
  }

  text = applyEdits(
    text,
    modify(text, ["mcp", options.spec.name], desired, {
      formattingOptions: FORMATTING,
    }),
  );
  writeTextFile(configPath, text.endsWith("\n") ? text : `${text}\n`);

  return {
    target: "opencode",
    action: existing === undefined ? "installed" : "unchanged",
    configPath,
    message: "Installed gdgraph opencode MCP configuration.",
  };
}

export function uninstallOpencodeTarget(options: InstallerTargetOptions): InstallerTargetResult {
  const configPath = opencodeConfigPath(options);
  const text = readTextFile(configPath);
  const parsed = parseJsoncObject(text);
  if (!parsed.ok) {
    return skipped(configPath, "Skipped opencode config because it is not valid JSONC.");
  }

  const desired = opencodeServerConfig(options);
  const mcp = isRecord(parsed.config.mcp) ? parsed.config.mcp : {};
  const existing = mcp[options.spec.name];
  if (existing === undefined) {
    return {
      target: "opencode",
      action: "unchanged",
      configPath,
      message: "No gdgraph opencode MCP configuration was found.",
    };
  }

  if (!jsonEqual(existing, desired)) {
    return skipped(
      configPath,
      "Skipped opencode uninstall because the godot-agent-graph server entry was changed by the user.",
    );
  }

  let updated = applyEdits(
    text,
    modify(text, ["mcp", options.spec.name], undefined, {
      formattingOptions: FORMATTING,
    }),
  );
  const after = parseJsoncObject(updated);
  if (after.ok && isRecord(after.config.mcp) && Object.keys(after.config.mcp).length === 0) {
    updated = applyEdits(
      updated,
      modify(updated, ["mcp"], undefined, {
        formattingOptions: FORMATTING,
      }),
    );
  }
  writeTextFile(configPath, updated.endsWith("\n") ? updated : `${updated}\n`);

  return {
    target: "opencode",
    action: "removed",
    configPath,
    message: "Removed gdgraph opencode MCP configuration.",
  };
}

function opencodeConfigPath(options: InstallerTargetOptions): string {
  const jsonc = join(options.projectRoot, "opencode.jsonc");
  const json = join(options.projectRoot, "opencode.json");
  if (existsSync(jsonc)) {
    return jsonc;
  }
  if (existsSync(json)) {
    return json;
  }
  return jsonc;
}

function opencodeServerConfig(options: InstallerTargetOptions): Record<string, unknown> {
  return {
    type: "local",
    command: [options.spec.command, ...options.spec.args],
    enabled: true,
  };
}

function parseJsoncObject(text: string): { ok: true; config: Record<string, unknown> } | { ok: false } {
  if (text.trim().length === 0) {
    return { ok: true, config: {} };
  }

  const errors: ParseError[] = [];
  const parsed = parseJsonc(text, errors, { allowTrailingComma: true });
  if (errors.length === 0 && isRecord(parsed)) {
    return { ok: true, config: parsed };
  }

  return { ok: false };
}

function skipped(configPath: string, message: string): InstallerTargetResult {
  return {
    target: "opencode",
    action: "skipped",
    configPath,
    message,
  };
}
