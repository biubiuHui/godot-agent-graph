import { Command } from "commander";
import { existsSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";

import { formatAgentContext } from "../context/agent-output.js";
import { agentOutputInvariantReason } from "../context/output-finalize.js";
import { exploreGodotContext } from "../context/explore.js";
import { getNodePayload } from "../context/node-payload.js";
import { createGraphDatabase } from "../db/index.js";
import { getProjectOverview } from "../graph/queries.js";
import {
  installGdgraphMcp,
  type InstallerTarget,
  uninstallGdgraphMcp,
} from "../installer/index.js";
import { serveGodotMcp, type ServeGodotMcpOptions } from "../mcp/server.js";
import { detectGodotProject } from "../project.js";
import {
  attachGraphQueryFreshness,
  attachStatusFreshness,
  getScanAwareGraphFreshness,
} from "../sync/freshness.js";
import { syncGodotProject, type SyncGodotProjectError, type SyncGodotProjectOk } from "../sync/index.js";

const SYNC_MESSAGE =
  "Synchronized graph index. Counts describe graph index changes, not Git status. Path lists are omitted to keep output compact.";
const REBUILD_SYNC_MESSAGE =
  "Rebuilt graph index from scratch. Counts describe files inserted into the new graph index, not Git status. Path lists are omitted to keep output compact.";

export interface CliProgramOptions {
  version: string;
  cwd?: string;
  write?: (text: string) => void;
  serveMcp?: (options: ServeGodotMcpOptions) => Promise<void>;
}

export function createCliProgram(options: CliProgramOptions): Command {
  const write = options.write ?? ((text: string) => process.stdout.write(text));
  const cwd = options.cwd ?? process.cwd();
  const program = new Command();

  program
    .name("gdgraph")
    .description("Godot project static knowledge graph tools")
    .showHelpAfterError()
    .exitOverride();

  program
    .command("version")
    .description("Print the gdgraph version")
    .action(() => {
      write(`${options.version}\n`);
    });

  program
    .command("clean")
    .argument("[path]", "Godot project path")
    .description("Remove gdgraph storage without rebuilding")
    .action((projectPath?: string) => {
      writeJson(write, cleanGdgraphStorage(resolveProjectPath(cwd, projectPath)));
    });

  program
    .command("sync")
    .argument("[path]", "Godot project path")
    .option("--rebuild", "Remove existing gdgraph storage before syncing")
    .description("Create, update, or rebuild the graph index")
    .action((projectPath?: string, commandOptions?: { rebuild?: boolean }) => {
      const root = resolveProjectPath(cwd, projectPath);
      const rebuild = commandOptions?.rebuild ?? false;
      if (rebuild) {
        const detected = detectGodotProject(root);
        if (!detected.ok) {
          writeJson(write, {
            ok: false,
            reason: detected.reason,
            message: "No project.godot found.",
            rebuilt: false,
          });
          return;
        }
        cleanGdgraphStorage(root);
      }

      const result = syncGodotProject(root);
      if (!result.ok) {
        writeJson(write, compactCliSyncErrorPayload(result, rebuild));
        return;
      }

      writeJson(write, compactCliSyncPayload(result, rebuild));
    });

  program
    .command("status")
    .argument("[path]", "Godot project path")
    .description("Show graph index status")
    .action((projectPath?: string) => {
      const root = resolveProjectPath(cwd, projectPath);
      const unavailable = uninitializedStatus(root);
      if (unavailable) {
        writeJson(write, unavailable);
        return;
      }

      withGraph(root, (graph) => {
        writeJson(
          write,
          attachStatusFreshness(
            {
              ok: true,
              initialized: true,
              ...overviewSummary(graph),
            },
            getScanAwareGraphFreshness(root, graph),
          ),
        );
      });
    });

  program
    .command("context")
    .argument("<query>", "Godot graph context query")
    .option("--path <path>", "Godot project path")
    .option("--code", "Include source snippets")
    .option("--max-files <number>", "Maximum files to include")
    .description("Return a compact Godot graph navigation package")
    .action((query: string, commandOptions: { path?: string; code?: boolean; maxFiles?: string }) => {
      withInitializedGraphCommand(cwd, commandOptions.path, write, (graph, root) => {
        const context = exploreGodotContext(graph, {
          projectRoot: root,
          query,
          maxFiles: optionalCliNumber(commandOptions.maxFiles) ?? 6,
          includeCode: commandOptions.code ?? false,
        });
        return attachGraphQueryFreshness(
          {
            ok: true,
            query,
            ...overviewSummary(graph),
            context: formatAgentContext(context, {
              maxChars: 4_800,
              maxNodes: 40,
              maxRelationships: 40,
              maxSnippets: 6,
            }),
          },
          getScanAwareGraphFreshness(root, graph),
        );
      });
    });

  program
    .command("node")
    .option("--path <path>", "Godot project path")
    .option("--file <res-path>", "Indexed file path")
    .option("--symbol <name>", "Indexed symbol name")
    .option("--id <graph-id>", "Indexed graph node id")
    .option("--offset <number>", "Source line offset")
    .option("--limit <number>", "Source line limit")
    .option("--no-code", "Exclude source text")
    .option("--no-notes", "Exclude relationship notes")
    .option("--symbols-only", "Return symbols without source text")
    .description("Read indexed source for one Godot file, symbol, or graph node")
    .action((commandOptions: {
      path?: string;
      file?: string;
      symbol?: string;
      id?: string;
      offset?: string;
      limit?: string;
      code?: boolean;
      notes?: boolean;
      symbolsOnly?: boolean;
    }) => {
      withInitializedGraphCommand(cwd, commandOptions.path, write, (graph, root) =>
        getNodePayload(graph, root, {
          file: commandOptions.file,
          symbol: commandOptions.symbol,
          id: commandOptions.id,
          offset: optionalCliNumber(commandOptions.offset),
          limit: optionalCliNumber(commandOptions.limit),
          includeCode: commandOptions.code,
          includeNotes: commandOptions.notes,
          symbolsOnly: commandOptions.symbolsOnly,
        }),
      );
    });

  program
    .command("serve")
    .option("--mcp", "Start an MCP stdio server")
    .argument("[path]", "Godot project path")
    .description("Start gdgraph services")
    .action(async (projectPath: string | undefined, commandOptions: { mcp?: boolean }) => {
      if (!commandOptions.mcp) {
        writeJson(write, {
          ok: false,
          message: "Only gdgraph serve --mcp is supported right now.",
        });
        return;
      }

      const serveMcp = options.serveMcp ?? serveGodotMcp;
      const projectRoot = resolveProjectPath(cwd, projectPath);
      await serveMcp({
        projectRoot,
      });
    });

  program
    .command("install")
    .argument("[path]", "Godot project path")
    .option("--target <target>", "Installer target: all, codex, claude, cursor, opencode, gemini, or kiro", "all")
    .option("--home <path>", "Home directory for user-scoped Agent config")
    .option("--command <command>", "gdgraph executable command", "gdgraph")
    .option("--with-skill", "Also install the Codex global skill when the codex target is selected")
    .description("Install gdgraph MCP configuration for supported Agents")
    .action(
      (
        projectPath: string | undefined,
        commandOptions: { target: string; home?: string; command: string; withSkill?: boolean },
      ) => {
        writeJson(
          write,
          installGdgraphMcp({
            projectRoot: resolveProjectPath(cwd, projectPath),
            homeDir: commandOptions.home,
            command: commandOptions.command,
            target: parseInstallerTarget(commandOptions.target),
            withSkill: commandOptions.withSkill ?? false,
          }),
        );
      },
    );

  program
    .command("uninstall")
    .argument("[path]", "Godot project path")
    .option("--target <target>", "Installer target: all, codex, claude, cursor, opencode, gemini, or kiro", "all")
    .option("--home <path>", "Home directory for user-scoped Agent config")
    .option("--command <command>", "gdgraph executable command", "gdgraph")
    .option("--with-skill", "Also remove the generated Codex global skill when the codex target is selected")
    .description("Remove gdgraph MCP configuration from supported Agents")
    .action(
      (
        projectPath: string | undefined,
        commandOptions: { target: string; home?: string; command: string; withSkill?: boolean },
      ) => {
        writeJson(
          write,
          uninstallGdgraphMcp({
            projectRoot: resolveProjectPath(cwd, projectPath),
            homeDir: commandOptions.home,
            command: commandOptions.command,
            target: parseInstallerTarget(commandOptions.target),
            withSkill: commandOptions.withSkill ?? false,
          }),
        );
      },
    );

  return program;
}

function resolveProjectPath(cwd: string, projectPath: string | undefined): string {
  return resolve(cwd, projectPath ?? ".");
}

function parseInstallerTarget(target: string): InstallerTarget {
  if (
    target === "all" ||
    target === "codex" ||
    target === "claude" ||
    target === "cursor" ||
    target === "opencode" ||
    target === "gemini" ||
    target === "kiro"
  ) {
    return target;
  }

  throw new Error(`Unsupported installer target: ${target}`);
}

function uninitializedStatus(root: string): Record<string, unknown> | null {
  const dbPath = join(root, ".gdgraph", "graph.db");
  if (existsSync(dbPath)) {
    return null;
  }

  return {
    ok: false,
    initialized: false,
    message: "No gdgraph index found. Run gdgraph sync first.",
  };
}

function cleanGdgraphStorage(projectRoot: string): Record<string, unknown> {
  const graphDir = join(projectRoot, ".gdgraph");
  const removed = existsSync(graphDir);
  if (removed) {
    rmSync(graphDir, { recursive: true, force: true });
  }

  return {
    ok: true,
    removed,
  };
}

function compactCliSyncPayload(result: SyncGodotProjectOk, rebuilt: boolean): Record<string, unknown> {
  const {
    added,
    modified,
    deleted,
    projectRoot: _projectRoot,
    databasePath: _databasePath,
    message: _message,
    parseErrors,
    ...rest
  } = result;
  return removeUndefined({
    ...rest,
    ...(rebuilt ? { rebuilt: true } : {}),
    addedCount: added.length,
    modifiedCount: modified.length,
    deletedCount: deleted.length,
    parseErrorCount: parseErrors.length,
    parseErrors: parseErrors.length > 0 ? parseErrors.slice(0, 10) : undefined,
    parseErrorsOmitted: Math.max(0, parseErrors.length - 10) || undefined,
    changeListsOmitted: true,
    message: rebuilt ? REBUILD_SYNC_MESSAGE : SYNC_MESSAGE,
  });
}

function compactCliSyncErrorPayload(result: SyncGodotProjectError, rebuilt: boolean): Record<string, unknown> {
  return removeUndefined({
    ok: false,
    reason: result.reason,
    message: compactCliErrorMessage(result),
    retryAfterMs: result.retryAfterMs,
    lockKind: result.lockKind,
    ...(rebuilt ? { rebuilt: false } : {}),
  });
}

function compactCliErrorMessage(result: SyncGodotProjectError): string {
  if (result.reason === "missing_project_godot") {
    return "No project.godot found.";
  }
  return redactLocalPaths(result.message);
}

export function cliCommandErrorPayload(error: unknown): Record<string, unknown> {
  const invariantReason = agentOutputInvariantReason(error);
  if (invariantReason) {
    return {
      ok: false,
      error: "agent_output_invariant",
      reason: invariantReason,
    };
  }

  return {
    ok: false,
    error: redactLocalPaths(error instanceof Error ? error.message : String(error)),
  };
}

function overviewSummary(graph: ReturnType<typeof createGraphDatabase>): Record<string, unknown> {
  const overview = getProjectOverview(graph);
  return {
    fileCount: overview.fileCount,
    nodeCount: overview.nodeCount,
    edgeCount: overview.edgeCount,
    unresolvedRefCount: overview.unresolvedRefCount,
    indexEmpty: overview.fileCount === 0 && overview.nodeCount === 0,
  };
}

function redactLocalPaths(value: string): string {
  return value
    .replace(/\/(?:Users|Volumes|private|var|tmp)\/[^\s"'{}[\],)]+/g, "[local-path]")
    .replace(/[A-Za-z]:\\[^\s"'{}[\],)]+/g, "[local-path]");
}

function removeUndefined<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(
    Object.entries(value).filter(([, entryValue]) => entryValue !== undefined),
  ) as T;
}

function withGraph(root: string, callback: (graph: ReturnType<typeof createGraphDatabase>) => void): void {
  const graph = createGraphDatabase(root);
  try {
    callback(graph);
  } finally {
    graph.close();
  }
}

function withInitializedGraphCommand(
  cwd: string,
  projectPath: string | undefined,
  write: (text: string) => void,
  callback: (graph: ReturnType<typeof createGraphDatabase>, root: string) => Record<string, unknown>,
): void {
  const root = resolveProjectPath(cwd, projectPath);
  const unavailable = uninitializedStatus(root);
  if (unavailable) {
    writeJson(write, unavailable);
    return;
  }

  withGraph(root, (graph) => {
    try {
      writeJson(write, callback(graph, root));
    } catch (error) {
      if (!agentOutputInvariantReason(error)) {
        throw error;
      }
      writeJson(write, cliCommandErrorPayload(error));
    }
  });
}

function optionalCliNumber(value: string | undefined): number | null {
  if (value === undefined) {
    return null;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function writeJson(write: (text: string) => void, value: unknown): void {
  write(`${JSON.stringify(value, null, 2)}\n`);
}
