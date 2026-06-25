import { describe, expect, it } from "vitest";

import { buildQueryPlan } from "../../../src/context/query-plan.js";

describe("context query planning", () => {
  it("classifies broad resource text queries and extracts directory anchors", () => {
    const plan = buildQueryPlan(
      "FixtureItemData display_text rule_text resources/items fixture item amber cobalt quartz",
    );

    expect(plan.strategy).toBe("resource-first");
    expect(plan.resourceDirectoryAnchors).toEqual(["resources/items"]);
    expect(plan.resourcePathAnchors).toEqual([]);
    expect(plan.symbolTerms).toEqual(expect.arrayContaining(["FixtureItemData"]));
    expect(plan.fieldTerms).toEqual(expect.arrayContaining(["display_text", "rule_text"]));
    expect(plan.textTerms).toEqual(expect.arrayContaining([
      "fixture",
      "item",
      "amber",
      "cobalt",
      "quartz",
    ]));
  });

  it("classifies exact resource path queries and records an exact resource anchor", () => {
    const plan = buildQueryPlan(
      "res://resources/pools/fixture_pool_primary.tres payload_id base_weight FixturePoolEntryData",
    );

    expect(plan.strategy).toBe("resource-first");
    expect(plan.resourcePathAnchors).toEqual(["res://resources/pools/fixture_pool_primary.tres"]);
    expect(plan.resourceDirectoryAnchors).toContain("resources/pools");
    expect(plan.fieldTerms).toEqual(expect.arrayContaining(["payload_id", "base_weight"]));
  });

  it("extracts resource-name anchors from high-specificity resource ids", () => {
    const plan = buildQueryPlan(
      "fixture_item_alpha_001 fixture_item_beta_002 resources/items FixtureItemData display_name description",
    );

    expect(plan.strategy).toBe("resource-first");
    expect(plan.resourceNameAnchors).toEqual([
      "fixture_item_alpha_001",
      "fixture_item_beta_002",
    ]);
    expect(plan.fieldTerms).toEqual(expect.arrayContaining(["display_name", "description"]));
  });

  it("disables fallback text for exact missing high-specificity checks", () => {
    const plan = buildQueryPlan(
      "definitely_missing_fixture_symbol_20260625 qqqq_never_fixture_symbol_abcxyz",
    );

    expect(plan.opaqueTerms).toEqual(expect.arrayContaining([
      "definitely_missing_fixture_symbol_20260625",
      "qqqq_never_fixture_symbol_abcxyz",
    ]));
    expect(plan.allowFallbackText).toBe(false);
  });

  it("keeps fallback text enabled for ordinary broad exploration", () => {
    const plan = buildQueryPlan("damage");

    expect(plan.strategy).toBe("general");
    expect(plan.allowFallbackText).toBe(true);
  });

  it("keeps relationship and source-oriented intent ahead of resource terms", () => {
    expect(buildQueryPlan("dependents FixtureActor resources/items").strategy).toBe("relationship");
    expect(buildQueryPlan("source res://scripts/fixture_actor.gd").strategy).toBe("source-oriented");
  });

  it("classifies exact symbol queries as symbol-first", () => {
    const plan = buildQueryPlan("FixtureActor apply_damage health_depleted");

    expect(plan.strategy).toBe("symbol-first");
    expect(plan.symbolTerms).toContain("FixtureActor");
    expect(plan.fieldTerms).toEqual(expect.arrayContaining(["apply_damage", "health_depleted"]));
  });

  it("keeps plain lowercase navigation queries general", () => {
    const plan = buildQueryPlan("damage");

    expect(plan.strategy).toBe("general");
    expect(plan.textTerms).toContain("damage");
  });
});
