# Godot Agent Graph 🗺️

为 AI 编程助手准备的 Godot 项目知识图谱。

它会在本地扫描 Godot 项目，把场景、脚本、资源、信号、autoload、节点路径和调用关系写入 SQLite 数据库。之后，Agent 可以先查图谱，再决定要读哪些源码。

这样做的好处很直接：减少无关文件读取，节省上下文和 token，也降低漏看场景关系、误改调用链的概率。

## 为什么需要它 🤖

Godot 项目变大后，Agent 如果只靠全文搜索和逐个打开文件，很容易绕远路。

比如一个 UI 问题，真正相关的内容可能分散在：

- `.tscn` 场景结构
- 挂在节点上的 `.gd` 脚本
- autoload 单例
- signal 连接
- resource 配置
- 测试文件

`gdgraph` 会先把这些关系整理成图谱。Agent 可以先问：

- ✅ 某个脚本或场景在哪里？
- ✅ 这个场景挂了哪些脚本？
- ✅ 这个方法被谁调用？
- ✅ 这个资源被哪些场景使用？
- ✅ 改某个文件前，应该先检查哪些相关文件？

它不是替代源码阅读，而是帮助 Agent 更快找到该读的文件。

## 本地安装 🛠️

当前 public 版本暂不发布 npm 包，先使用源码安装。

要求：

- Node.js 20 或更高版本
- npm

安装：

```bash
git clone https://github.com/biubiuHui/godot-agent-graph.git
cd godot-agent-graph
npm install
npm run build
npm install -g .
```

确认命令可用：

```bash
gdgraph version
```

更新本地版本：

```bash
cd /path/to/godot-agent-graph
git pull
npm install
npm run build
npm install -g .
```

## 初始化图谱 🧭

路径必须指向 Godot 项目根目录，也就是包含 `project.godot` 的目录。

```bash
gdgraph init /path/to/godot/project
```

查看图谱状态：

```bash
gdgraph status /path/to/godot/project
```

图谱数据库会生成在项目目录下：

```text
/path/to/godot/project/.gdgraph/graph.db
```

`.gdgraph/` 是本地生成数据，不需要提交到 Git。

项目文件改动后，同步图谱：

```bash
gdgraph sync /path/to/godot/project
```

从零重建：

```bash
gdgraph rebuild /path/to/godot/project
```

删除本地图谱：

```bash
gdgraph clean /path/to/godot/project
```

## 常用查询 🔎

搜索脚本、场景、资源或符号：

```bash
gdgraph search FixtureActor --path /path/to/godot/project
```

查看场景结构：

```bash
gdgraph scene res://fixture_main.tscn --path /path/to/godot/project
```

获取适合 Agent 阅读的上下文：

```bash
gdgraph explore FixtureActor --path /path/to/godot/project
```

查看调用关系：

```bash
gdgraph callers apply_damage --path /path/to/godot/project
gdgraph callees FixtureActor --path /path/to/godot/project
```

改动前查看影响范围：

```bash
gdgraph impact res://scripts/fixture_actor.gd --path /path/to/godot/project
```

## 接入 Agent 🔌

`gdgraph` 可以作为 MCP server 接入常见 Agent 客户端。

写入 MCP 配置：

```bash
gdgraph install /path/to/godot/project
```

默认会为这些客户端写配置：

- Codex
- Claude Code
- Cursor
- opencode
- Gemini
- Kiro

只安装某一个客户端：

```bash
gdgraph install /path/to/godot/project --target codex
```

安装后，重启对应的 Agent 客户端，让它重新加载 MCP 工具。

MCP 工具包括：

```text
godot_status
godot_context
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

一般 Godot 结构、脚本、场景、资源、信号、节点路径或调用链问题，优先调用 `godot_context`。它会返回简短上下文和后续建议工具。

如果工具返回 `indexFresh: false`，说明图谱可能落后于当前文件。先调用 `godot_sync`，或在命令行运行 `gdgraph sync`。

## 建议写进 AGENTS.md 📌

如果希望 Agent 在探索项目时自动优先使用知识图谱，可以把下面规则加入 Godot 项目的 `AGENTS.md`：

```markdown
## Godot 知识图谱

本项目使用 `gdgraph` 维护 Godot 代码图谱。

- 在进行大范围源码探索前，先使用知识图谱。
- 优先调用 `godot_context` 获取第一份图谱上下文。
- 调用 `godot_status` 查看图谱状态。
- 如果图谱不存在，运行 `gdgraph init <project>`。
- 如果 `indexFresh` 为 `false`，先调用 `godot_sync`，或运行 `gdgraph sync <project>`。
- 查找脚本、场景、资源、调用关系或影响范围时，使用 `godot_search`、`godot_explore`、`godot_scene`、`godot_impact`。
- 如果当前会话没有 MCP 工具，则使用 `gdgraph` CLI，再按需读取源码。
```

这条规则可以让 Agent 先看项目关系，再打开少量关键文件。对场景和脚本很多的 Godot 项目尤其有用。

## 索引范围 📚

`gdgraph` 会读取：

- `project.godot`
- `.gd`
- `.tscn`
- `.tres`

它会记录：

- 项目名、主场景、autoload、input action
- 场景和场景节点
- 脚本类、方法、属性、信号
- 资源文件和脚本挂载
- 场景实例关系
- 节点路径引用
- 能静态解析的方法调用和信号连接

扫描时会跳过常见生成目录和外部目录，例如 `.git/`、`.godot/`、`.import/`、`.gdgraph/`、`node_modules/`、`dist/`、`addons/`、`demo/`。

## 当前边界 ⚠️

这是静态分析工具，不会运行 Godot 项目。

它主要解析写在项目文件里的显式关系。运行时动态创建的节点、复杂类型流、字符串拼接路径等，不会强行猜测。无法确认的关系会保留为 unresolved refs，避免生成错误边。

## 开发 🧪

```bash
npm install
npm test
npm run build
npm run gdgraph -- version
```

使用 fixture 快速试跑：

```bash
npm run gdgraph -- init tests/fixtures/godot/minimal
npm run gdgraph -- explore FixtureActor --path tests/fixtures/godot/minimal
```

## 参考 🔗

- [CLI Reference](docs/reference/cli.md)
- [MCP Tools Reference](docs/reference/mcp.md)
- [Installer Reference](docs/reference/install.md)
- [Privacy And Release Guardrails](docs/reference/privacy.md)
- [Architecture](docs/reference/architecture.md)
- [Troubleshooting](docs/reference/troubleshooting.md)
- [Minimal Fixture Walkthrough](examples/minimal-walkthrough.md)
