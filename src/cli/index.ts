import { Command } from "commander";
import { existsSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";

import {
  exploreGodotContext,
  getCalleesContext,
  getCallersContext,
} from "../context/explore.js";
import { createGraphDatabase } from "../db/index.js";
import { getImpactContext } from "../graph/impact.js";
import {
  findSymbols,
  getProjectOverview,
  getSceneDetails,
  listIndexedFiles,
} from "../graph/queries.js";
import { indexGodotProject } from "../indexer/indexer.js";
import {
  installGdgraphMcp,
  type InstallerTarget,
  uninstallGdgraphMcp,
} from "../installer/index.js";
import { serveGodotMcp, type ServeGodotMcpOptions } from "../mcp/server.js";
import { searchGraph } from "../search/index.js";
import { attachFreshness, getGraphFreshness } from "../sync/freshness.js";
import { syncGodotProject } from "../sync/index.js";

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
    .command("init")
    .argument("[path]", "Godot project path")
    .description("Initialize gdgraph storage and run a full index")
    .action((projectPath?: string) => {
      writeJson(write, indexGodotProject(resolveProjectPath(cwd, projectPath)));
    });

  program
    .command("index")
    .argument("[path]", "Godot project path")
    .description("Rebuild the gdgraph index")
    .action((projectPath?: string) => {
      writeJson(write, indexGodotProject(resolveProjectPath(cwd, projectPath)));
    });

  program
    .command("rebuild")
    .argument("[path]", "Godot project path")
    .description("Rebuild the gdgraph index")
    .action((projectPath?: string) => {
      writeJson(write, indexGodotProject(resolveProjectPath(cwd, projectPath)));
    });

  program
    .command("clean")
    .argument("[path]", "Godot project path")
    .description("Remove gdgraph storage without rebuilding")
    .action((projectPath?: string) => {
      writeJson(write, cleanGdgraphStorage(resolveProjectPath(cwd, projectPath)));
    });

  program
    .command("uninit")
    .argument("[path]", "Godot project path")
    .description("Remove gdgraph storage without rebuilding")
    .action((projectPath?: string) => {
      writeJson(write, cleanGdgraphStorage(resolveProjectPath(cwd, projectPath)));
    });

  program
    .command("sync")
    .argument("[path]", "Godot project path")
    .description("Synchronize changed Godot files into the graph index")
    .action((projectPath?: string) => {
      const result = syncGodotProject(resolveProjectPath(cwd, projectPath));
      if (!result.ok) {
        writeJson(write, result);
        return;
      }

      writeJson(write, {
        ...result,
        addedCount: result.added.length,
        modifiedCount: result.modified.length,
        deletedCount: result.deleted.length,
      });
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
          attachFreshness(
            {
              ok: true,
              initialized: true,
              dbPath: graph.databasePath,
              ...getProjectOverview(graph),
            },
            getGraphFreshness(root, graph),
          ),
        );
      });
    });

  program
    .command("files")
    .argument("[path]", "Godot project path")
    .description("List indexed Godot files")
    .action((projectPath?: string) => {
      const root = resolveProjectPath(cwd, projectPath);
      const unavailable = uninitializedStatus(root);
      if (unavailable) {
        writeJson(write, unavailable);
        return;
      }

      withGraph(root, (graph) => {
        writeJson(write, {
          ok: true,
          files: listIndexedFiles(graph),
        });
      });
    });

  program
    .command("search")
    .argument("<query>", "Search query")
    .option("--path <path>", "Godot project path")
    .description("Search indexed graph nodes")
    .action((query: string, commandOptions: { path?: string }) => {
      const root = resolveProjectPath(cwd, commandOptions.path);
      const unavailable = uninitializedStatus(root);
      if (unavailable) {
        writeJson(write, unavailable);
        return;
      }

      withGraph(root, (graph) => {
        writeJson(write, {
          ok: true,
          results: searchGraph(graph, query),
        });
      });
    });

  program
    .command("scene")
    .argument("<scene-path>", "Scene resource path")
    .option("--path <path>", "Godot project path")
    .description("Show indexed scene details")
    .action((scenePath: string, commandOptions: { path?: string }) => {
      const root = resolveProjectPath(cwd, commandOptions.path);
      const unavailable = uninitializedStatus(root);
      if (unavailable) {
        writeJson(write, unavailable);
        return;
      }

      withGraph(root, (graph) => {
        writeJson(write, {
          ok: true,
          ...getSceneDetails(graph, scenePath),
        });
      });
    });

  program
    .command("symbol")
    .argument("<name>", "Symbol name")
    .option("--path <path>", "Godot project path")
    .description("Find indexed symbols")
    .action((name: string, commandOptions: { path?: string }) => {
      const root = resolveProjectPath(cwd, commandOptions.path);
      const unavailable = uninitializedStatus(root);
      if (unavailable) {
        writeJson(write, unavailable);
        return;
      }

      withGraph(root, (graph) => {
        writeJson(write, {
          ok: true,
          results: findSymbols(graph, name),
        });
      });
    });

  program
    .command("explore")
    .argument("<query>", "Feature, symbol, scene, or resource query")
    .option("--path <path>", "Godot project path")
    .option("--no-code", "Exclude source snippets")
    .description("Return an Agent-ready Godot context package")
    .action((query: string, commandOptions: { path?: string; code?: boolean }) => {
      withInitializedGraphCommand(cwd, commandOptions.path, write, (graph, root) => ({
        ok: true,
        ...exploreGodotContext(graph, {
          projectRoot: root,
          query,
          includeCode: commandOptions.code ?? true,
        }),
      }));
    });

  program
    .command("callers")
    .argument("<symbol>", "Symbol to find callers for")
    .option("--path <path>", "Godot project path")
    .option("--no-code", "Exclude source snippets")
    .description("Return caller context")
    .action((symbol: string, commandOptions: { path?: string; code?: boolean }) => {
      withInitializedGraphCommand(cwd, commandOptions.path, write, (graph, root) => ({
        ok: true,
        ...getCallersContext(graph, {
          projectRoot: root,
          symbol,
          includeCode: commandOptions.code ?? true,
        }),
      }));
    });

  program
    .command("callees")
    .argument("<symbol>", "Symbol to find callees for")
    .option("--path <path>", "Godot project path")
    .option("--no-code", "Exclude source snippets")
    .description("Return callee context")
    .action((symbol: string, commandOptions: { path?: string; code?: boolean }) => {
      withInitializedGraphCommand(cwd, commandOptions.path, write, (graph, root) => ({
        ok: true,
        ...getCalleesContext(graph, {
          projectRoot: root,
          symbol,
          includeCode: commandOptions.code ?? true,
        }),
      }));
    });

  program
    .command("impact")
    .argument("<target>", "Symbol or file path to analyze")
    .option("--path <path>", "Godot project path")
    .description("Return impact context before editing")
    .action((target: string, commandOptions: { path?: string }) => {
      withInitializedGraphCommand(cwd, commandOptions.path, write, (graph) => ({
        ok: true,
        ...getImpactContext(graph, target),
      }));
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
      syncGodotProject(projectRoot);
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
    .description("Install gdgraph MCP configuration for supported Agents")
    .action(
      (
        projectPath: string | undefined,
        commandOptions: { target: string; home?: string; command: string },
      ) => {
        writeJson(
          write,
          installGdgraphMcp({
            projectRoot: resolveProjectPath(cwd, projectPath),
            homeDir: commandOptions.home,
            command: commandOptions.command,
            target: parseInstallerTarget(commandOptions.target),
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
    .description("Remove gdgraph MCP configuration from supported Agents")
    .action(
      (
        projectPath: string | undefined,
        commandOptions: { target: string; home?: string; command: string },
      ) => {
        writeJson(
          write,
          uninstallGdgraphMcp({
            projectRoot: resolveProjectPath(cwd, projectPath),
            homeDir: commandOptions.home,
            command: commandOptions.command,
            target: parseInstallerTarget(commandOptions.target),
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
    projectRoot: root,
    dbPath,
    message: "No gdgraph index found. Run gdgraph init first.",
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
    projectRoot,
    graphDir,
    removed,
  };
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
    writeJson(write, callback(graph, root));
  });
}

function writeJson(write: (text: string) => void, value: unknown): void {
  write(`${JSON.stringify(value, null, 2)}\n`);
}
