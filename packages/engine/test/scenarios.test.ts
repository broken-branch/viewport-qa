import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseScenarioRecipe, prepareScenarios } from "../src/scenarios.js";

const VALID_STEPS = [
  { click: { role: "button", name: "Open filters" } },
  { fill: { role: "textbox", name: "Search", value: "Ada" } },
  { waitFor: { role: "dialog", name: "Settings" } },
  { route: { url: "/api/records", status: 200, body: "[]" } },
];

describe("parseScenarioRecipe", () => {
  it("accepts every supported step kind without changing the recipe", () => {
    const recipe = [{ label: "Record view", url: "/records", steps: VALID_STEPS }];

    expect(parseScenarioRecipe(JSON.stringify(recipe))).toEqual(recipe);
  });

  it.each([
    { value: {}, error: "recipe must be an array" },
    { value: [{ label: "", url: "/", steps: [] }], error: "scenarios[0].label must be a non-empty string" },
    { value: [{ label: "Panel", url: "/", steps: [] }, { label: "Panel", url: "/other", steps: [] }], error: 'scenarios[1].label duplicates "Panel"' },
    { value: [{ label: "Panel", url: "", steps: [] }], error: "scenarios[0].url must be a non-empty string" },
    { value: [{ label: "Panel", url: "/", steps: [{ click: { role: "button", name: "Open" }, waitFor: { role: "dialog", name: "Panel" } }] }], error: "scenarios[0].steps[0] must contain exactly one supported step" },
    { value: [{ label: "Panel", url: "/", steps: [{ fill: { role: "textbox", name: "Search" } }] }], error: "scenarios[0].steps[0].fill.value must be a string" },
    { value: [{ label: "Panel", url: "/", steps: [{ route: { url: "/api/list", status: 99, body: "[]" } }] }], error: "scenarios[0].steps[0].route.status must be an integer from 100 through 599" },
  ])("rejects the first invalid recipe field: $error", ({ value, error }) => {
    expect(() => parseScenarioRecipe(JSON.stringify(value))).toThrow(error);
  });

  it("reports malformed JSON as the first recipe error", () => {
    expect(() => parseScenarioRecipe("["))
      .toThrow("recipe is not valid JSON");
  });

  it("keeps the checked-in example recipe valid", async () => {
    const example = await readFile(
      join(import.meta.dirname, "../../../docs/examples/scenarios.json"),
      "utf8",
    );

    expect(parseScenarioRecipe(example).map((scenario) => scenario.label)).toEqual([
      "Toolbar panel",
      "Settings modal",
      "Empty records",
    ]);
  });
});

describe("prepareScenarios", () => {
  it("resolves scenario and route URLs without widening the target origin", () => {
    const [scenario] = prepareScenarios("https://example.test/app/", [{
      label: "Empty records",
      url: "records",
      steps: [{ route: { url: "../api/records", status: 200, body: "[]" } }],
    }]);

    expect(scenario?.url).toBe("https://example.test/app/records");
    expect(scenario?.steps[0]).toEqual({
      route: { url: "https://example.test/api/records", status: 200, body: "[]" },
    });
  });

  it.each([
    {
      scenario: { label: "Escape", url: "https://other.test/", steps: [] },
      error: "scenarios[0].url must stay on the scan target origin",
    },
    {
      scenario: {
        label: "Escape",
        url: "/",
        steps: [{ route: { url: "https://other.test/api", status: 200, body: "[]" } }],
      },
      error: "scenarios[0].steps[0].route.url must stay on the scenario origin",
    },
  ])("rejects an origin-widening recipe: $error", ({ scenario, error }) => {
    expect(() => prepareScenarios("https://example.test/", [scenario]))
      .toThrow(error);
  });
});
