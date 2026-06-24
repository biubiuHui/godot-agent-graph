# Minimal Fixture Walkthrough

This walkthrough uses the checked-in minimal Godot fixture. It exercises the current public CLI surface: `sync`, `status`, `context`, and `node`.

From the repository root:

```bash
npm install
npm run build
```

Index or update the fixture:

```bash
npm run gdgraph -- sync tests/fixtures/godot/minimal
```

Check graph health and freshness:

```bash
npm run gdgraph -- status tests/fixtures/godot/minimal
```

Expected highlights:

- `initialized: true`
- `indexFresh: true`
- project name `MinimalFixture`

Ask for Agent-ready navigation context:

```bash
npm run gdgraph -- context "FixtureActor _ready fixture_main" --path tests/fixtures/godot/minimal
```

Read one indexed symbol:

```bash
npm run gdgraph -- node --path tests/fixtures/godot/minimal --symbol FixtureActor
```

Read one indexed file:

```bash
npm run gdgraph -- node --path tests/fixtures/godot/minimal --file res://scripts/fixture_actor.gd --limit 40
```

After changing fixture files, run normal incremental sync again:

```bash
npm run gdgraph -- sync tests/fixtures/godot/minimal
```

Use a full rebuild only when you want to discard the existing graph first:

```bash
npm run gdgraph -- sync tests/fixtures/godot/minimal --rebuild
```

Do not commit generated `.gdgraph/` fixture databases; they are local runtime artifacts.
