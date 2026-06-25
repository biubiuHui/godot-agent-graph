import { describe, expect, it } from "vitest";

import { formatAgentContext } from "../../../src/context/agent-output.js";
import { applyOutputBudget } from "../../../src/context/output-budget.js";
import {
  AgentOutputInvariantError,
  agentOutputInvariantReason,
  finalizeAgentOutput,
  isAgentOutputInvariantError,
} from "../../../src/context/output-finalize.js";
import { contextToOutputView, nodeReadToOutputView } from "../../../src/context/output-view.js";

function node(
  id: string,
  kind: string,
  name: string,
  filePath: string | null,
  signature: string | null = null,
) {
  const selector = filePath ? { id, kind, path: filePath } : { id };
  return {
    id,
    kind,
    name,
    qualifiedName: name,
    filePath,
    addressKind: filePath ? "indexed_symbol" : "opaque",
    ownerPath: filePath,
    readablePath: filePath,
    displayPath: filePath,
    referencePath: null,
    selector,
    startLine: 1,
    signature,
  };
}

function viewNode(id: string, kind: string, name: string, filePath: string) {
  return {
    graphId: id,
    kind,
    name,
    qualifiedName: name,
    filePath,
    addressKind: "indexed_symbol",
    ownerPath: filePath,
    readablePath: filePath,
    displayPath: filePath,
    referencePath: null,
    selector: { id, kind, path: filePath },
    startLine: 1,
    signature: null,
    priority: 0,
    protected: true,
  };
}

describe("agent output formatter", () => {
  it("types output invariant errors with compact sanitized reasons", () => {
    const error = new AgentOutputInvariantError("orphan_context_path");

    expect(isAgentOutputInvariantError(error)).toBe(true);
    expect(agentOutputInvariantReason(error)).toBe("orphan_context_path");
    expect(error.message).toBe("Agent output invariant failed");
    expect(error.message).not.toContain("res://");
    expect(error.message).not.toContain("graphId");
  });

  it("keeps output view selection separate from final compact references", () => {
    const view = contextToOutputView({
      query: "Visible",
      nodes: [
        node("script:res://scripts/visible.gd", "script_class", "Visible", "res://scripts/visible.gd"),
      ],
      relationships: [
        "script:res://scripts/visible.gd calls method:res://scripts/visible.gd:run (resolver)",
      ],
      snippets: [],
      maxChars: 8_000,
    });

    expect(view.kind).toBe("context");
    expect(view.nodes[0]).toEqual(expect.objectContaining({
      graphId: "script:res://scripts/visible.gd",
      protected: true,
    }));
    expect(view.relationships[0]).toEqual(expect.objectContaining({
      source: "script:res://scripts/visible.gd",
      kind: "calls",
      target: "method:res://scripts/visible.gd:run",
      provenance: "resolver",
    }));
    expect(JSON.stringify(view)).not.toContain("\"paths\"");
    expect(JSON.stringify(view)).not.toContain("\"selectors\"");
  });

  it("budgets the view before finalizing compact paths and selectors", () => {
    const view = contextToOutputView({
      query: "Visible",
      nodes: [
        node("script:res://scripts/visible.gd", "script_class", "Visible", "res://scripts/visible.gd"),
      ],
      relationships: [
        "script:res://scripts/visible.gd calls method:res://scripts/kept.gd:run (resolver)",
        "script:res://scripts/visible.gd calls method:res://scripts/hidden.gd:run (resolver)",
      ],
      snippets: [
        {
          filePath: "res://scripts/hidden_snippet.gd",
          startLine: 1,
          endLine: 1,
          text: "hidden",
        },
      ],
      maxChars: 8_000,
    });

    const budgeted = applyOutputBudget(view, {
      maxNodes: 1,
      maxRelationships: 1,
      maxSnippets: 0,
      maxChars: 8_000,
    });
    const output = finalizeAgentOutput(budgeted);
    const serialized = JSON.stringify(output);

    expect(output.omitted).toEqual({
      nodes: 0,
      relationships: 1,
      snippets: 1,
    });
    expect(output.truncated).toBe(true);
    expect(serialized).toContain("kept.gd");
    expect(serialized).not.toContain("hidden.gd");
    expect(serialized).not.toContain("hidden_snippet.gd");
  });

  it("finalizes node reads without note-only path references", () => {
    const output = finalizeAgentOutput(nodeReadToOutputView({
      target: viewNode(
        "script:res://scripts/fixture_actor.gd",
        "script_class",
        "FixtureActor",
        "res://scripts/fixture_actor.gd",
      ),
      symbols: [
        viewNode(
          "method:res://scripts/fixture_actor.gd:_ready",
          "method",
          "_ready",
          "res://scripts/fixture_actor.gd",
        ),
      ],
      source: {
        filePath: "res://scripts/fixture_actor.gd",
        startLine: 1,
        endLine: 2,
        text: "1\textends Node\n2\tclass_name FixtureActor",
      },
      staleFilePaths: [],
      maxChars: 8_000,
    }));

    expect(output).toEqual(expect.objectContaining({
      ok: true,
      paths: {
        p1: "res://scripts/fixture_actor.gd",
      },
      target: expect.objectContaining({
        id: "n1",
        path: "p1",
      }),
      symbols: [
        expect.objectContaining({
          id: "n2",
          path: "p1",
        }),
      ],
    }));
    expect(output).not.toHaveProperty("notes");
    expect(JSON.stringify(output)).not.toContain("autoload_fixture.gd");
  });

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
    expect(output).toEqual(expect.objectContaining({
      resultHint: "navigation_sample_not_exhaustive",
    }));
    expect(output.omitted.snippets).toBeGreaterThan(0);
    expect(output.budget.maxChars).toBe(400);
    expect(output.budget.estimatedChars).toBeLessThanOrEqual(400);
  });

  it("marks incomplete bounded context as a navigation sample", () => {
    const output = formatAgentContext({
      query: "FixtureActor",
      strategy: "symbol-first",
      completeness: {
        scope: "bounded_navigation",
        complete: false,
      },
      nodes: [
        {
          id: "script:res://scripts/fixture_actor.gd",
          kind: "script_class",
          name: "FixtureActor",
          qualifiedName: "FixtureActor",
          filePath: "res://scripts/fixture_actor.gd",
          startLine: 1,
          signature: "class_name FixtureActor",
        },
      ],
      relationships: [],
      files: ["res://scripts/fixture_actor.gd"],
      snippets: [],
    });

    expect(output).toEqual(expect.objectContaining({
      completeness: {
        scope: "bounded_navigation",
        complete: false,
      },
      resultHint: "navigation_sample_not_exhaustive",
      truncated: false,
    }));
  });

  it("uses a dedicated hint when context has no indexed matches", () => {
    const output = formatAgentContext({
      query: "definitely_missing_fixture_symbol_20260625",
      strategy: "symbol-first",
      completeness: {
        scope: "bounded_navigation",
        complete: false,
      },
      nodes: [],
      relationships: [],
      files: [],
      snippets: [],
    });

    expect(output).toEqual(expect.objectContaining({
      resultHint: "no_indexed_matches",
      paths: {},
      nodes: [],
      relationships: [],
      snippets: [],
    }));
  });

  it("does not report no indexed matches when budget omitted every matched node", () => {
    const output = formatAgentContext(
      {
        query: "FixtureActor",
        strategy: "symbol-first",
        completeness: {
          scope: "bounded_navigation",
          complete: false,
        },
        nodes: [
          {
            id: "script:res://scripts/fixture_actor.gd",
            kind: "script_class",
            name: "FixtureActor",
            qualifiedName: "FixtureActor",
            filePath: "res://scripts/fixture_actor.gd",
            startLine: 1,
            signature: "class_name FixtureActor",
          },
        ],
        relationships: [],
        files: ["res://scripts/fixture_actor.gd"],
        snippets: [],
      },
      {
        maxNodes: 0,
        maxRelationships: 0,
        maxSnippets: 0,
        maxChars: 8_000,
      },
    );

    expect(output).toEqual(expect.objectContaining({
      resultHint: "navigation_sample_not_exhaustive",
      nodes: [],
      omitted: expect.objectContaining({
        nodes: 1,
      }),
      omittedSummary: {
        nodes: {
          script: 1,
        },
      },
    }));
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
    expect(output.paths).toEqual({
      p1: "res://scripts/visible.gd",
    });
    expect(output.selectors).toEqual({
      n2: {
        id: "script:res://scripts/omitted.gd",
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
    expect(Object.values(output.paths)).not.toContain("res://scripts/omitted.gd");
  });

  it("prunes paths for nodes omitted from the formatted output", () => {
    const output = formatAgentContext(
      {
        query: "Visible",
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
          ...Array.from({ length: 5 }, (_, index) => ({
            id: `resource:res://resources/noise_${index}.tres`,
            kind: "resource",
            name: `noise_${index}.tres`,
            qualifiedName: `res://resources/noise_${index}.tres`,
            filePath: `res://resources/noise_${index}.tres`,
            startLine: 1,
            signature: "Resource",
          })),
        ],
        relationships: [],
        files: ["res://scripts/visible.gd"],
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
    expect(output.omitted.nodes).toBe(5);
    expect(output.paths).toEqual({
      p1: "res://scripts/visible.gd",
    });
    expect(JSON.stringify(output)).not.toContain("resources/noise_");
  });

  it("summarizes omitted node categories when nodes are budgeted out", () => {
    const output = formatAgentContext(
      {
        query: "VisibleResourceSceneTest",
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
            id: "resource:res://resources/fixture_profile.tres",
            kind: "resource",
            name: "fixture_profile.tres",
            qualifiedName: "res://resources/fixture_profile.tres",
            filePath: "res://resources/fixture_profile.tres",
            startLine: 1,
            signature: "Resource",
          },
          {
            id: "scene_node:res://scenes/fixture_scene.tscn:FixtureNode",
            kind: "scene_node",
            name: "FixtureNode",
            qualifiedName: "FixtureNode",
            filePath: "res://scenes/fixture_scene.tscn",
            startLine: 4,
            signature: "Node2D",
          },
          {
            id: "method:res://tests/fixture_flow_test.gd:test_flow",
            kind: "method",
            name: "test_flow",
            qualifiedName: "FixtureFlowTest.test_flow",
            filePath: "res://tests/fixture_flow_test.gd",
            startLine: 5,
            signature: "func test_flow() -> void:",
          },
          {
            id: "property:res://scripts/fixture_model.gd:fixture_value",
            kind: "property",
            name: "fixture_value",
            qualifiedName: "FixtureModel.fixture_value",
            filePath: "res://scripts/fixture_model.gd",
            startLine: 3,
            signature: "var fixture_value := 1",
          },
        ],
        relationships: [],
        files: ["res://scripts/visible.gd"],
        snippets: [],
      },
      {
        maxNodes: 1,
        maxRelationships: 10,
        maxSnippets: 10,
        maxChars: 8_000,
      },
    );

    expect(output.omitted.nodes).toBe(4);
    expect(output.omittedSummary).toEqual({
      nodes: {
        resource: 1,
        scene: 1,
        test: 1,
        script: 1,
      },
    });
  });

  it("prunes selectors and paths for relationships omitted by output limits", () => {
    const output = formatAgentContext(
      {
        query: "Visible",
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
        ],
        relationships: [
          "script:res://scripts/visible.gd calls method:res://scripts/kept.gd:run (resolver)",
          "script:res://scripts/visible.gd calls method:res://scripts/hidden_one.gd:run (resolver)",
          "script:res://scripts/visible.gd calls method:res://scripts/hidden_two.gd:run (resolver)",
        ],
        files: ["res://scripts/visible.gd"],
        snippets: [],
      },
      {
        maxNodes: 1,
        maxRelationships: 1,
        maxSnippets: 10,
        maxChars: 8_000,
      },
    );

    expect(output.relationships).toEqual([
      {
        from: "n1",
        kind: "calls",
        to: "n2",
        provenance: "resolver",
      },
    ]);
    expect(output.omitted.relationships).toBe(2);
    expect(output.paths).toEqual({
      p1: "res://scripts/visible.gd",
    });
    expect(output.selectors).toEqual({
      n2: {
        id: "method:res://scripts/kept.gd:run",
      },
    });
    const serialized = JSON.stringify(output);
    expect(serialized).not.toContain("hidden_one");
    expect(serialized).not.toContain("hidden_two");
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

  it("keeps unparsable relationship text as a related target", () => {
    const output = formatAgentContext({
      query: "Fixture",
      nodes: [],
      relationships: ["unstructured relationship text"],
      files: [],
      snippets: [],
    });

    expect(output.relationships).toEqual([
      {
        kind: "related",
        target: "unstructured relationship text",
        provenance: "text",
      },
    ]);
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

  it("does not create orphan paths for visible graph-id resource nodes without file paths", () => {
    const output = formatAgentContext({
      query: "resource placeholder",
      entryPoints: [
        "resource:res://resources/fixture_stats.tres",
        "resource:res://scripts/fixture_stats_data.gd",
      ],
      nodes: [
        {
          id: "resource:res://resources/fixture_stats.tres",
          kind: "resource",
          name: "fixture_stats.tres",
          qualifiedName: "res://resources/fixture_stats.tres",
          filePath: "res://resources/fixture_stats.tres",
          startLine: 1,
          signature: "FixtureStats",
        },
        {
          id: "resource:res://scripts/fixture_stats_data.gd",
          kind: "resource",
          name: "fixture_stats_data.gd",
          qualifiedName: "res://scripts/fixture_stats_data.gd",
          filePath: null,
          startLine: 1,
          signature: "Script",
        },
      ],
      relationships: [],
      pathsBetween: [
        "resource:res://resources/fixture_stats.tres loads_resource resource:res://scripts/fixture_stats_data.gd (resource-parser)",
      ],
      files: ["res://resources/fixture_stats.tres"],
      snippets: [],
    });

    expect(output.pathsBetween).toEqual([
      {
        from: "n1",
        kind: "loads_resource",
        to: "n2",
        provenance: "resource-parser",
      },
    ]);
    expect(Object.values(output.paths)).toEqual(["res://resources/fixture_stats.tres"]);
  });

  it("does not derive hidden endpoint paths from graph ids without address fields", () => {
    const output = finalizeAgentOutput({
      kind: "context",
      query: "hidden endpoint",
      entryPointIds: ["script:res://scripts/fixture_actor.gd"],
      pathsBetween: [],
      nodes: [
        viewNode(
          "script:res://scripts/fixture_actor.gd",
          "script_class",
          "FixtureActor",
          "res://scripts/fixture_actor.gd",
        ),
      ],
      relationships: [
        {
          source: "script:res://scripts/fixture_actor.gd",
          kind: "loads_resource",
          target: "resource:res://missing/fixture_hidden.tres",
          provenance: "resource-parser",
          priority: 1,
          protected: true,
        },
      ],
      snippets: [],
      omitted: { nodes: 0, relationships: 0, snippets: 0 },
      truncated: false,
      budget: { maxChars: 8_000, estimatedChars: 0 },
    });

    expect(Object.values(output.paths)).toEqual(["res://scripts/fixture_actor.gd"]);
  });
});
