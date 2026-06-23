import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { homedir } from "node:os";

export type ConcreteInstallerTarget = "codex" | "claude" | "cursor" | "opencode" | "gemini" | "kiro";
export type InstallerTarget = "all" | ConcreteInstallerTarget;
export type InstallerAction = "installed" | "removed" | "unchanged" | "skipped";

export interface McpServerSpec {
  name: "godot-agent-graph";
  command: string;
  args: string[];
}

export interface InstallerOptions {
  target?: InstallerTarget;
  projectRoot?: string;
  homeDir?: string;
  command?: string;
  withSkill?: boolean;
}

export interface InstallerTargetOptions {
  projectRoot: string;
  homeDir: string;
  spec: McpServerSpec;
  withSkill: boolean;
}

export interface InstallerTargetResult {
  target: ConcreteInstallerTarget;
  action: InstallerAction;
  configPath: string;
  message: string;
}

export interface InstallerResult {
  ok: boolean;
  results: InstallerTargetResult[];
  verificationHints: string[];
}

export function normalizeInstallerOptions(options: InstallerOptions): InstallerTargetOptions {
  const projectRoot = resolve(options.projectRoot ?? ".");
  const command = options.command ?? "gdgraph";

  return {
    projectRoot,
    homeDir: resolve(options.homeDir ?? homedir()),
    withSkill: options.withSkill ?? false,
    spec: {
      name: "godot-agent-graph",
      command,
      args: ["serve", "--mcp", projectRoot],
    },
  };
}

export function readTextFile(path: string): string {
  return existsSync(path) ? readFileSync(path, "utf8") : "";
}

export function writeTextFile(path: string, contents: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents);
}

export function installerOk(results: InstallerTargetResult[]): boolean {
  return results.every((result) => result.action !== "skipped");
}

export function standardMcpServerConfig(options: InstallerTargetOptions): Record<string, unknown> {
  return {
    type: "stdio",
    command: options.spec.command,
    args: options.spec.args,
  };
}

export function readJsonObject(path: string): { ok: true; config: Record<string, unknown> } | { ok: false } {
  const contents = readTextFile(path);
  if (contents.trim().length === 0) {
    return { ok: true, config: {} };
  }

  try {
    const parsed = JSON.parse(contents) as unknown;
    if (isRecord(parsed)) {
      return { ok: true, config: parsed };
    }
  } catch {
    return { ok: false };
  }

  return { ok: false };
}

export function writeJsonObject(path: string, config: Record<string, unknown>): void {
  writeTextFile(path, `${JSON.stringify(config, null, 2)}\n`);
}

export function jsonEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
