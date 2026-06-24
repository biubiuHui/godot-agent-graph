import { describe, expect, it } from "vitest";

import { formatAgentContext } from "../../../src/context/agent-output.js";

describe("agent output formatter", () => {
  it("interns paths and graph node ids into compact agent context", () => {
    const input = {
      query: "TargetPanel",
      nodes: [
        {
          id: "script:res://scripts/ui/panels/target_panel.gd",
          kind: "script_class",
          name: "TargetPanel",
          qualifiedName: "TargetPanel",
          filePath: "res://scripts/ui/panels/target_panel.gd",
          startLine: 2,
          signature: "class_name TargetPanel",
        },
        {
          id: "method:res://scripts/ui/panels/target_panel.gd:refresh",
          kind: "method",
          name: "refresh",
          qualifiedName: "TargetPanel.refresh",
          filePath: "res://scripts/ui/panels/target_panel.gd",
          startLine: 8,
          signature: "func refresh() -> void",
        },
      ],
      relationships: [
        "script:res://scripts/ui/panels/target_panel.gd contains method:res://scripts/ui/panels/target_panel.gd:refresh (parser)",
      ],
      files: ["res://scripts/ui/panels/target_panel.gd"],
      snippets: [
        {
          filePath: "res://scripts/ui/panels/target_panel.gd",
          startLine: 1,
          endLine: 4,
          text: "extends Node\nclass_name TargetPanel",
        },
      ],
    };
    const oldPathOccurrences =
      JSON.stringify(input).match(/res:\/\/scripts\/ui\/panels\/target_panel\.gd/g)?.length ?? 0;
    const output = formatAgentContext(input);

    expect(output).toEqual(
      expect.objectContaining({
        query: "TargetPanel",
        paths: {
          p1: "res://scripts/ui/panels/target_panel.gd",
        },
        nodes: [
          expect.objectContaining({
            id: "n1",
            kind: "script_class",
            name: "TargetPanel",
            path: "p1",
            line: 2,
          }),
          expect.objectContaining({
            id: "n2",
            path: "p1",
            line: 8,
          }),
        ],
        relationships: [
          {
            from: "n1",
            kind: "contains",
            to: "n2",
            provenance: "parser",
          },
        ],
        snippets: [
          {
            path: "p1",
            start: 1,
            end: 4,
            text: "extends Node\nclass_name TargetPanel",
          },
        ],
        truncated: false,
        omitted: {
          nodes: 0,
          relationships: 0,
          snippets: 0,
        },
        budget: expect.objectContaining({
          maxChars: expect.any(Number),
          estimatedChars: expect.any(Number),
        }),
      }),
    );

    const serialized = JSON.stringify(output);
    const newPathOccurrences =
      serialized.match(/res:\/\/scripts\/ui\/panels\/target_panel\.gd/g)?.length ?? 0;
    expect(serialized).not.toContain("graphId");
    expect(newPathOccurrences).toBeLessThan(oldPathOccurrences);
    expect(newPathOccurrences).toBe(1);
    expect(serialized).not.toContain("projectRoot");
  });

  it("omits qname when it only repeats a resource path", () => {
    const output = formatAgentContext({
      query: "FixtureStats",
      nodes: [
        {
          id: "resource:res://resources/fixture_stats.tres",
          kind: "resource",
          name: "fixture_stats.tres",
          qualifiedName: "res://resources/fixture_stats.tres",
          filePath: "res://resources/fixture_stats.tres",
          startLine: 1,
          signature: null,
        },
      ],
      relationships: [],
      files: ["res://resources/fixture_stats.tres"],
      snippets: [],
    });

    expect(output.nodes).toEqual([
      {
        id: "n1",
        kind: "resource",
        name: "fixture_stats.tres",
        path: "p1",
        line: 1,
      },
    ]);
    expect(JSON.stringify(output).match(/res:\/\/resources\/fixture_stats\.tres/g)?.length).toBe(1);
  });

  it("uses compact selectors for graph-id-only context targets", () => {
    const output = formatAgentContext({
      query: "FixtureActor scene node",
      nodes: [
        {
          id: "scene_node:res://scenes/fixture_main.tscn:Main/FixtureActor",
          kind: "scene_node",
          name: "FixtureActor",
          qualifiedName: "res://scenes/fixture_main.tscn:Main/FixtureActor",
          filePath: "res://scenes/fixture_main.tscn",
          startLine: 7,
          signature: "CharacterBody2D",
        },
      ],
      relationships: [],
      files: ["res://scenes/fixture_main.tscn"],
      snippets: [],
    });

    expect(output.nodes[0]).toEqual({
      id: "n1",
      kind: "scene_node",
      name: "FixtureActor",
      path: "p1",
      line: 7,
      signature: "CharacterBody2D",
    });
    expect(output.selectors).toEqual({
      n1: {
        kind: "scene_node",
        path: "p1",
        suffix: "Main/FixtureActor",
      },
    });
    expect(JSON.stringify(output).match(/res:\/\/scenes\/fixture_main\.tscn/g)?.length).toBe(1);
  });

  it("uses prefix aliases for repeated deep directory paths", () => {
    const output = formatAgentContext({
      query: "Panels",
      nodes: [
        {
          id: "script:res://scripts/ui/panels/target_panel.gd",
          kind: "script_class",
          name: "TargetPanel",
          qualifiedName: "TargetPanel",
          filePath: "res://scripts/ui/panels/target_panel.gd",
          startLine: 2,
          signature: null,
        },
        {
          id: "script:res://scripts/ui/panels/summary_panel.gd",
          kind: "script_class",
          name: "SummaryPanel",
          qualifiedName: "SummaryPanel",
          filePath: "res://scripts/ui/panels/summary_panel.gd",
          startLine: 2,
          signature: null,
        },
      ],
      relationships: [],
      files: [
        "res://scripts/ui/panels/target_panel.gd",
        "res://scripts/ui/panels/summary_panel.gd",
      ],
      snippets: [],
    });

    expect(output.prefixes).toEqual({
      "@p1": "res://scripts/ui/panels/",
    });
    expect(output.paths).toEqual({
      p1: "@p1/target_panel.gd",
      p2: "@p1/summary_panel.gd",
    });
  });

  it("truncates oversized context and reports omitted counts", () => {
    const output = formatAgentContext(
      {
        query: "LargeContext",
        nodes: [
          {
            id: "script:res://scripts/large_context.gd",
            kind: "script_class",
            name: "LargeContext",
            qualifiedName: "LargeContext",
            filePath: "res://scripts/large_context.gd",
            startLine: 1,
            signature: null,
          },
        ],
        relationships: [
          "script:res://scripts/large_context.gd contains method:res://scripts/large_context.gd:step_one (parser)",
          "script:res://scripts/large_context.gd contains method:res://scripts/large_context.gd:step_two (parser)",
        ],
        files: ["res://scripts/large_context.gd"],
        snippets: [
          {
            filePath: "res://scripts/large_context.gd",
            startLine: 1,
            endLine: 40,
            text: "x".repeat(600),
          },
        ],
      },
      {
        maxChars: 400,
        maxNodes: 10,
        maxRelationships: 10,
        maxSnippets: 10,
      },
    );

    expect(output.truncated).toBe(true);
    expect(output.omitted.snippets).toBeGreaterThan(0);
    expect(output.budget.maxChars).toBe(400);
    expect(output.budget.estimatedChars).toBeLessThanOrEqual(400);
  });

  it("uses compact selectors for relationship endpoints outside visible nodes", () => {
    const output = formatAgentContext(
      {
        query: "OmittedNode",
        nodes: [
          {
            id: "script:res://scripts/visible.gd",
            kind: "script_class",
            name: "Visible",
            qualifiedName: "Visible",
            filePath: "res://scripts/visible.gd",
            startLine: 1,
            signature: null,
          },
          {
            id: "script:res://scripts/omitted.gd",
            kind: "script_class",
            name: "Omitted",
            qualifiedName: "Omitted",
            filePath: "res://scripts/omitted.gd",
            startLine: 1,
            signature: null,
          },
        ],
        relationships: [
          "script:res://scripts/visible.gd calls script:res://scripts/omitted.gd (resolver)",
        ],
        files: ["res://scripts/visible.gd", "res://scripts/omitted.gd"],
        snippets: [],
      },
      {
        maxNodes: 1,
        maxRelationships: 10,
        maxSnippets: 10,
        maxChars: 8_000,
      },
    );

    expect(output.nodes).toHaveLength(1);
    expect(output.nodes[0].id).toBe("n1");
    expect(output.omitted.nodes).toBe(1);
    expect(output.prefixes).toEqual({
      "@p1": "res://scripts/",
    });
    expect(output.paths).toEqual({
      p1: "@p1/visible.gd",
      p2: "@p1/omitted.gd",
    });
    expect(output.selectors).toEqual({
      n2: {
        kind: "script",
        path: "p2",
      },
    });
    expect(output.relationships).toEqual([
      {
        from: "n1",
        kind: "calls",
        to: "n2",
        provenance: "resolver",
      },
    ]);
    expect(JSON.stringify(output)).not.toContain("graphTo");
    expect(JSON.stringify(output)).not.toContain("graphFrom");
    expect(JSON.stringify(output)).not.toContain("script:res://scripts/omitted.gd");
  });

  it("uses path refs for unresolved resource path targets", () => {
    const output = formatAgentContext({
      query: "SampleResource",
      nodes: [
        {
          id: "method:res://scripts/sample_loader.gd:_ready",
          kind: "method",
          name: "_ready",
          qualifiedName: "SampleLoader._ready",
          filePath: "res://scripts/sample_loader.gd",
          startLine: 5,
          signature: "func _ready() -> void:",
        },
      ],
      relationships: [
        "method:res://scripts/sample_loader.gd:_ready loads_resource res://resources/sample_profile.tres (unresolved)",
      ],
      files: ["res://scripts/sample_loader.gd"],
      snippets: [],
    });

    expect(output.paths).toEqual({
      p1: "res://scripts/sample_loader.gd",
      p2: "res://resources/sample_profile.tres",
    });
    expect(output.relationships).toEqual([
      {
        from: "n1",
        kind: "loads_resource",
        targetPath: "p2",
        provenance: "unresolved",
      },
    ]);
    expect(JSON.stringify(output.relationships)).not.toContain("res://resources/sample_profile.tres");
  });

  it("preserves focused relationships before lower-value nodes when truncated", () => {
    const fillerNodes = Array.from({ length: 24 }, (_, index) => ({
      id: `property:res://scripts/sample/filler_${index}.gd:SAMPLE_VALUE_${index}`,
      kind: "property",
      name: `SAMPLE_VALUE_${index}`,
      qualifiedName: `SampleFiller${index}.SAMPLE_VALUE_${index}`,
      filePath: `res://scripts/sample/filler_${index}.gd`,
      startLine: 3,
      signature: `const SAMPLE_VALUE_${index} := "${"x".repeat(80)}"`,
    }));

    const output = formatAgentContext(
      {
        query: "SampleScreen SampleTimeline",
        entryPoints: [
          "script:res://scripts/sample/sample_screen.gd",
          "script:res://scripts/sample/sample_timeline.gd",
        ],
        nodes: [
          {
            id: "script:res://scripts/sample/sample_screen.gd",
            kind: "script_class",
            name: "SampleScreen",
            qualifiedName: "SampleScreen",
            filePath: "res://scripts/sample/sample_screen.gd",
            startLine: 1,
            signature: "class_name SampleScreen",
          },
          {
            id: "script:res://scripts/sample/sample_timeline.gd",
            kind: "script_class",
            name: "SampleTimeline",
            qualifiedName: "SampleTimeline",
            filePath: "res://scripts/sample/sample_timeline.gd",
            startLine: 1,
            signature: "class_name SampleTimeline",
          },
          ...fillerNodes,
        ],
        relationships: [
          "script:res://scripts/sample/sample_screen.gd calls script:res://scripts/sample/sample_timeline.gd (resolver)",
          "script:res://scripts/sample/sample_screen.gd references_symbol SAMPLE_VALUE_0 (unresolved)",
          "script:res://scripts/sample/sample_timeline.gd references_symbol SAMPLE_VALUE_1 (unresolved)",
        ],
        files: [
          "res://scripts/sample/sample_screen.gd",
          "res://scripts/sample/sample_timeline.gd",
          ...fillerNodes.map((node) => node.filePath),
        ],
        snippets: [],
      },
      {
        maxChars: 1_600,
        maxNodes: 30,
        maxRelationships: 10,
        maxSnippets: 0,
      },
    );

    expect(output.truncated).toBe(true);
    expect(output.omitted.nodes).toBeGreaterThan(0);
    expect(output.relationships).toEqual(expect.arrayContaining([
      expect.objectContaining({
        from: "n1",
        kind: "calls",
        to: "n2",
        provenance: "resolver",
      }),
    ]));
    expect(output.budget.estimatedChars).toBeLessThanOrEqual(1_600);
  });

  it("formats paths between entry points with compact ids", () => {
    const output = formatAgentContext({
      query: "ScreenController TimelineBuilder",
      entryPoints: [
        "script:res://scripts/screen_controller.gd",
        "script:res://scripts/timeline_builder.gd",
      ],
      nodes: [
        {
          id: "script:res://scripts/screen_controller.gd",
          kind: "script_class",
          name: "ScreenController",
          qualifiedName: "ScreenController",
          filePath: "res://scripts/screen_controller.gd",
          startLine: 1,
          signature: null,
        },
        {
          id: "script:res://scripts/timeline_builder.gd",
          kind: "script_class",
          name: "TimelineBuilder",
          qualifiedName: "TimelineBuilder",
          filePath: "res://scripts/timeline_builder.gd",
          startLine: 1,
          signature: null,
        },
      ],
      relationships: [],
      pathsBetween: [
        "script:res://scripts/screen_controller.gd calls script:res://scripts/timeline_builder.gd (resolver)",
      ],
      files: [
        "res://scripts/screen_controller.gd",
        "res://scripts/timeline_builder.gd",
      ],
      snippets: [],
    });

    expect(output.pathsBetween).toEqual([
      {
        from: "n1",
        kind: "calls",
        to: "n2",
        provenance: "resolver",
      },
    ]);
  });
});
