# Godot Agent Graph

Godot Agent Graph 是一个面向 AI 编程助手的 Godot 项目知识图工具。

它会在本地索引 Godot 项目，把场景、脚本、资源、信号、autoload、输入映射和调用关系写入 SQLite 图数据库。之后你可以通过 CLI 或 MCP 工具查询项目结构，让 Agent 在改代码前先知道“这个东西在哪里、被谁使用、可能影响哪些场景”。

## 它能做什么

- 索引 `project.godot`、`.gd`、`.tscn`、`.tres`。
- 识别项目、场景、场景节点、脚本类、方法、属性、信号、资源、autoload 和 input action。
- 解析常见关系：脚本挂载、场景实例、资源加载、方法调用、信号连接、autoload 使用、节点路径引用。
- 提供搜索、场景查看、符号查看、调用方/被调用方、影响分析等查询。
- 启动 MCP server，让 Codex、Claude Code、Cursor、opencode、Gemini、Kiro 等客户端直接调用图谱工具。

## 适合什么场景

- Godot 项目变大后，想快速弄清脚本和场景之间的关系。
- 让 AI Agent 修改代码前先查项目图谱，减少盲猜。
- 想知道一个脚本、方法、场景或资源改动后可能影响哪些文件。
- 想把 Godot 项目的结构信息交给 MCP 客户端使用。

## 安装

```bash
npm install -g godot-agent-graph
```

安装后会得到 `gdgraph` 命令。

本仓库开发环境可以这样运行：

```bash
npm install
npm run build
npm run gdgraph -- version
```

## 五分钟上手

先索引一个 Godot 项目：

```bash
gdgraph init /path/to/godot/project
```

查看索引状态：

```bash
gdgraph status /path/to/godot/project
```

搜索脚本、场景、资源或符号：

```bash
gdgraph search FixtureActor --path /path/to/godot/project
```

查看某个场景：

```bash
gdgraph scene res://fixture_main.tscn --path /path/to/godot/project
```

让工具整理一份适合 Agent 阅读的上下文：

```bash
gdgraph explore FixtureActor --path /path/to/godot/project
```

分析改动影响：

```bash
gdgraph impact res://scripts/fixture_actor.gd --path /path/to/godot/project
```

项目文件改动后，刷新图谱：

```bash
gdgraph sync /path/to/godot/project
```

需要彻底重建时：

```bash
gdgraph rebuild /path/to/godot/project
```

## MCP 接入

手动启动 MCP server：

```bash
gdgraph serve --mcp /path/to/godot/project
```

也可以让工具写入常见客户端的 MCP 配置：

```bash
gdgraph install /path/to/godot/project
```

支持的目标包括：

```text
codex
claude
cursor
opencode
gemini
kiro
```

安装后，Agent 可以调用这些工具：

```text
godot_status
godot_project_map
godot_sync
godot_search
godot_scene
godot_explore
godot_symbol
godot_callers
godot_callees
godot_impact
```

如果 MCP 返回 `indexFresh: false`，说明图谱可能落后于文件改动。先调用 `godot_sync`，或者检查返回里的 pending files。

## 常用命令

```bash
gdgraph init [path]       # 初始化并索引项目
gdgraph status [path]     # 查看图谱状态
gdgraph sync [path]       # 同步文件改动
gdgraph rebuild [path]    # 清空旧记录并重建
gdgraph clean [path]      # 删除 .gdgraph 本地存储

gdgraph search <query> --path <path>
gdgraph scene <scene-path> --path <path>
gdgraph symbol <name> --path <path>
gdgraph explore <query> --path <path>
gdgraph callers <symbol> --path <path>
gdgraph callees <symbol> --path <path>
gdgraph impact <symbol-or-file> --path <path>
```

## 数据放在哪里

图数据库保存在 Godot 项目目录下：

```text
<project>/.gdgraph/graph.db
```

它是本地运行产物，不需要提交到 Git。默认 `.gitignore` 应该忽略 `.gdgraph/`。

扫描时会跳过常见生成目录和第三方目录，包括 `.git/`、`.godot/`、`.import/`、`.gdgraph/`、`node_modules/`、`dist/`、`addons/`、`demo/` 等。

## 当前边界

这是静态分析工具，不会运行 Godot 项目。它能稳定解析项目内的显式关系，但对运行时动态创建的节点、复杂类型流和字符串拼接路径不会强行猜测。无法确认的引用会留在 unresolved refs 里，避免生成错误边。

## 开发

```bash
npm install
npm test
npm run build
npm run gdgraph -- version
```

本仓库包含一个最小 Godot fixture，可用于快速试跑：

```bash
npm run gdgraph -- init tests/fixtures/godot/minimal
npm run gdgraph -- explore FixtureActor --path tests/fixtures/godot/minimal
```

## 参考文档

- [CLI Reference](docs/reference/cli.md)
- [MCP Tools Reference](docs/reference/mcp.md)
- [Installer Reference](docs/reference/install.md)
- [Architecture](docs/reference/architecture.md)
- [Troubleshooting](docs/reference/troubleshooting.md)
- [Minimal Fixture Walkthrough](examples/minimal-walkthrough.md)
