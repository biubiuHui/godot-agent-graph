import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  installGdgraphMcp,
  uninstallGdgraphMcp,
} from "../../../src/installer/index.js";

const tempRoots: string[] = [];

function tempRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  tempRoots.push(root);
  return root;
}

function readText(path: string): string {
  return readFileSync(path, "utf8");
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
});

describe("gdgraph MCP installer", () => {
  const originalArgv1 = process.argv[1];

  afterEach(() => {
    process.argv[1] = originalArgv1;
  });

  it("installs a marked Codex MCP server block and preserves unrelated config", () => {
    const homeDir = tempRoot("gdgraph-installer-home-");
    const projectRoot = tempRoot("gdgraph-installer-project-");
    const configPath = join(homeDir, ".codex", "config.toml");
    mkdirSync(join(homeDir, ".codex"), { recursive: true });
    writeFileSync(configPath, "model = \"gpt-5-codex\"\n");

    const result = installGdgraphMcp({
      target: "codex",
      homeDir,
      projectRoot,
      command: "gdgraph",
    });

    expect(result.ok).toBe(true);
    expect(result.results).toEqual([
      expect.objectContaining({
        action: "installed",
        configPath,
        target: "codex",
      }),
    ]);

    expect(readText(configPath)).toBe(
      `model = "gpt-5-codex"

# godot-agent-graph:begin codex
[mcp_servers.godot-agent-graph]
command = "gdgraph"
args = ["serve", "--mcp", "${projectRoot}"]
enabled = true
startup_timeout_sec = 60
# godot-agent-graph:end codex
`,
    );
  });

  it("uses an absolute Node launch spec for Codex when installed from the gdgraph bin", () => {
    const homeDir = tempRoot("gdgraph-installer-home-");
    const projectRoot = tempRoot("gdgraph-installer-project-");
    const configPath = join(homeDir, ".codex", "config.toml");
    const gdgraphBin = join(homeDir, "gdgraph.js");
    process.argv[1] = gdgraphBin;

    const result = installGdgraphMcp({
      target: "codex",
      homeDir,
      projectRoot,
    });

    expect(result.ok).toBe(true);
    expect(readText(configPath)).toContain(`command = "${process.execPath}"`);
    expect(readText(configPath)).toContain(
      `args = ["${gdgraphBin}", "serve", "--mcp", "${projectRoot}"]`,
    );
  });

  it("uses an absolute Node launch spec for Codex from a Windows gdgraph bin path", () => {
    const homeDir = tempRoot("gdgraph-installer-home-");
    const projectRoot = tempRoot("gdgraph-installer-project-");
    const configPath = join(homeDir, ".codex", "config.toml");
    const gdgraphBin = String.raw`C:\Users\player\AppData\Roaming\npm\node_modules\godot-agent-graph\dist\bin\gdgraph.js`;
    process.argv[1] = gdgraphBin;

    const result = installGdgraphMcp({
      target: "codex",
      homeDir,
      projectRoot,
    });

    expect(result.ok).toBe(true);
    expect(readText(configPath)).toContain(`command = "${process.execPath}"`);
    expect(readText(configPath)).toContain(JSON.stringify(gdgraphBin));
  });

  it("uninstalls only the owned Codex block", () => {
    const homeDir = tempRoot("gdgraph-installer-home-");
    const projectRoot = tempRoot("gdgraph-installer-project-");
    const configPath = join(homeDir, ".codex", "config.toml");
    mkdirSync(join(homeDir, ".codex"), { recursive: true });
    writeFileSync(
      configPath,
      `approval_policy = "never"

# godot-agent-graph:begin codex
[mcp_servers.godot-agent-graph]
command = "gdgraph"
args = ["serve", "--mcp", "${projectRoot}"]
enabled = true
startup_timeout_sec = 60
# godot-agent-graph:end codex

[mcp_servers.context7]
command = "context7"
`,
    );

    const result = uninstallGdgraphMcp({
      target: "codex",
      homeDir,
      projectRoot,
      command: "gdgraph",
    });

    expect(result.ok).toBe(true);
    expect(result.results).toEqual([
      expect.objectContaining({
        action: "removed",
        configPath,
        target: "codex",
      }),
    ]);
    expect(readText(configPath)).toBe(`approval_policy = "never"

[mcp_servers.context7]
command = "context7"
`);
  });

  it("skips an unowned Codex gdgraph table instead of overwriting it", () => {
    const homeDir = tempRoot("gdgraph-installer-home-");
    const projectRoot = tempRoot("gdgraph-installer-project-");
    const configPath = join(homeDir, ".codex", "config.toml");
    mkdirSync(join(homeDir, ".codex"), { recursive: true });
    writeFileSync(
      configPath,
      `[mcp_servers.godot-agent-graph]
command = "custom-gdgraph"
`,
    );

    const result = installGdgraphMcp({
      target: "codex",
      homeDir,
      projectRoot,
      command: "gdgraph",
    });

    expect(result.ok).toBe(false);
    expect(result.results).toEqual([
      expect.objectContaining({
        action: "skipped",
        configPath,
        target: "codex",
      }),
    ]);
    expect(readText(configPath)).toBe(`[mcp_servers.godot-agent-graph]
command = "custom-gdgraph"
`);
  });

  it("installs a Claude Code MCP server and preserves unrelated servers", () => {
    const homeDir = tempRoot("gdgraph-installer-home-");
    const projectRoot = tempRoot("gdgraph-installer-project-");
    const configPath = join(projectRoot, ".mcp.json");
    writeFileSync(
      configPath,
      JSON.stringify(
        {
          mcpServers: {
            context7: {
              type: "stdio",
              command: "context7",
            },
          },
          otherSetting: true,
        },
        null,
        2,
      ),
    );

    const result = installGdgraphMcp({
      target: "claude",
      homeDir,
      projectRoot,
      command: "gdgraph",
    });

    expect(result.ok).toBe(true);
    expect(result.results).toEqual([
      expect.objectContaining({
        action: "installed",
        configPath,
        target: "claude",
      }),
    ]);
    expect(JSON.parse(readText(configPath))).toEqual({
      mcpServers: {
        context7: {
          type: "stdio",
          command: "context7",
        },
        "godot-agent-graph": {
          type: "stdio",
          command: "gdgraph",
          args: ["serve", "--mcp", projectRoot],
        },
      },
      otherSetting: true,
    });
  });

  it("skips an existing different Claude gdgraph server entry", () => {
    const homeDir = tempRoot("gdgraph-installer-home-");
    const projectRoot = tempRoot("gdgraph-installer-project-");
    const configPath = join(projectRoot, ".mcp.json");
    writeFileSync(
      configPath,
      JSON.stringify(
        {
          mcpServers: {
            "godot-agent-graph": {
              type: "stdio",
              command: "custom-gdgraph",
            },
          },
        },
        null,
        2,
      ),
    );

    const result = installGdgraphMcp({
      target: "claude",
      homeDir,
      projectRoot,
      command: "gdgraph",
    });

    expect(result.ok).toBe(false);
    expect(result.results).toEqual([
      expect.objectContaining({
        action: "skipped",
        configPath,
        target: "claude",
      }),
    ]);
    expect(JSON.parse(readText(configPath)).mcpServers["godot-agent-graph"]).toEqual({
      type: "stdio",
      command: "custom-gdgraph",
    });
  });

  it("uninstalls only the generated Claude Code entry", () => {
    const homeDir = tempRoot("gdgraph-installer-home-");
    const projectRoot = tempRoot("gdgraph-installer-project-");
    const configPath = join(projectRoot, ".mcp.json");
    writeFileSync(
      configPath,
      JSON.stringify(
        {
          mcpServers: {
            context7: {
              type: "stdio",
              command: "context7",
            },
            "godot-agent-graph": {
              type: "stdio",
              command: "gdgraph",
              args: ["serve", "--mcp", projectRoot],
            },
          },
        },
        null,
        2,
      ),
    );

    const result = uninstallGdgraphMcp({
      target: "claude",
      homeDir,
      projectRoot,
      command: "gdgraph",
    });

    expect(result.ok).toBe(true);
    expect(result.results).toEqual([
      expect.objectContaining({
        action: "removed",
        configPath,
        target: "claude",
      }),
    ]);
    expect(JSON.parse(readText(configPath))).toEqual({
      mcpServers: {
        context7: {
          type: "stdio",
          command: "context7",
        },
      },
    });
  });

  it("installs Cursor MCP configuration in the project", () => {
    const homeDir = tempRoot("gdgraph-installer-home-");
    const projectRoot = tempRoot("gdgraph-installer-project-");
    const configPath = join(projectRoot, ".cursor", "mcp.json");

    const result = installGdgraphMcp({
      target: "cursor",
      homeDir,
      projectRoot,
      command: "gdgraph",
    });

    expect(result.ok).toBe(true);
    expect(JSON.parse(readText(configPath))).toEqual({
      mcpServers: {
        "godot-agent-graph": {
          type: "stdio",
          command: "gdgraph",
          args: ["serve", "--mcp", projectRoot],
        },
      },
    });
  });

  it("installs opencode JSONC configuration without removing user comments", () => {
    const homeDir = tempRoot("gdgraph-installer-home-");
    const projectRoot = tempRoot("gdgraph-installer-project-");
    const configPath = join(projectRoot, "opencode.jsonc");
    writeFileSync(
      configPath,
      `{
  // keep this comment
  "$schema": "https://opencode.ai/config.json"
}
`,
    );

    const result = installGdgraphMcp({
      target: "opencode",
      homeDir,
      projectRoot,
      command: "gdgraph",
    });

    expect(result.ok).toBe(true);
    const text = readText(configPath);
    expect(text).toContain("// keep this comment");
    expect(text).toContain(`"godot-agent-graph"`);
    expect(text).toContain(`"command": [`);
    expect(text).toContain(`"gdgraph"`);
    expect(text).toContain(projectRoot);
  });

  it("installs Gemini MCP configuration in the project", () => {
    const homeDir = tempRoot("gdgraph-installer-home-");
    const projectRoot = tempRoot("gdgraph-installer-project-");
    const configPath = join(projectRoot, ".gemini", "settings.json");

    const result = installGdgraphMcp({
      target: "gemini",
      homeDir,
      projectRoot,
      command: "gdgraph",
    });

    expect(result.ok).toBe(true);
    expect(JSON.parse(readText(configPath))).toEqual({
      mcpServers: {
        "godot-agent-graph": {
          type: "stdio",
          command: "gdgraph",
          args: ["serve", "--mcp", projectRoot],
        },
      },
    });
  });

  it("installs Kiro MCP configuration in the project", () => {
    const homeDir = tempRoot("gdgraph-installer-home-");
    const projectRoot = tempRoot("gdgraph-installer-project-");
    const configPath = join(projectRoot, ".kiro", "settings", "mcp.json");

    const result = installGdgraphMcp({
      target: "kiro",
      homeDir,
      projectRoot,
      command: "gdgraph",
    });

    expect(result.ok).toBe(true);
    expect(JSON.parse(readText(configPath))).toEqual({
      mcpServers: {
        "godot-agent-graph": {
          type: "stdio",
          command: "gdgraph",
          args: ["serve", "--mcp", projectRoot],
        },
      },
    });
  });
});
