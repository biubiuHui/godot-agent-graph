# Minimal Fixture Walkthrough

This walkthrough uses the checked-in minimal Godot fixture.

From the repository root:

```bash
npm install
npm run build
```

Index the fixture:

```bash
npm run gdgraph -- init tests/fixtures/godot/minimal
```

Check status:

```bash
npm run gdgraph -- status tests/fixtures/godot/minimal
```

Expected highlights:

- `initialized: true`
- `fileCount: 3`
- project name `MinimalFixture`

Search the player script:

```bash
npm run gdgraph -- search FixtureActor --path tests/fixtures/godot/minimal
```

Inspect the main scene:

```bash
npm run gdgraph -- scene res://fixture_main.tscn --path tests/fixtures/godot/minimal
```

Explore Agent-ready context:

```bash
npm run gdgraph -- explore FixtureActor --path tests/fixtures/godot/minimal
```

Analyze impact before editing:

```bash
npm run gdgraph -- impact res://scripts/fixture_actor.gd --path tests/fixtures/godot/minimal
```

After changing fixture files, sync:

```bash
npm run gdgraph -- sync tests/fixtures/godot/minimal
```

Do not commit generated `.gdgraph/` fixture databases; they are local runtime artifacts.
