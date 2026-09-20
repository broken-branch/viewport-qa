import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import type { Scenario, ScenarioStep } from "@vqa/contract";
import type { Page } from "playwright";

const STEP_KINDS = ["click", "fill", "waitFor", "route"] as const;

type JsonRecord = Record<string, unknown>;

export class ScenarioRecipeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ScenarioRecipeError";
  }
}

function recordAt(value: unknown, path: string): JsonRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ScenarioRecipeError(`${path} must be an object`);
  }
  return value as JsonRecord;
}

function stringAt(record: JsonRecord, key: string, path: string, allowEmpty = false): string {
  const value = record[key];
  if (typeof value !== "string" || (!allowEmpty && value.trim() === "")) {
    throw new ScenarioRecipeError(`${path}.${key} must be a${allowEmpty ? "" : " non-empty"} string`);
  }
  return value;
}

function exactKeys(record: JsonRecord, expected: readonly string[], path: string): void {
  const keys = Object.keys(record);
  if (keys.length !== expected.length || keys.some((key) => !expected.includes(key))) {
    throw new ScenarioRecipeError(`${path} must contain exactly ${expected.join(", ")}`);
  }
}

function targetStep(value: unknown, path: string, withValue: boolean): ScenarioStep {
  const target = recordAt(value, path);
  const role = stringAt(target, "role", path);
  const name = stringAt(target, "name", path);
  const fillValue = withValue ? stringAt(target, "value", path, true) : undefined;
  exactKeys(target, withValue ? ["role", "name", "value"] : ["role", "name"], path);
  return withValue
    ? { fill: { role, name, value: fillValue! } }
    : path.endsWith(".click")
      ? { click: { role, name } }
      : { waitFor: { role, name } };
}

function scenarioStep(value: unknown, path: string): ScenarioStep {
  const step = recordAt(value, path);
  const kinds = STEP_KINDS.filter((kind) => Object.hasOwn(step, kind));
  if (kinds.length !== 1 || Object.keys(step).length !== 1) {
    throw new ScenarioRecipeError(`${path} must contain exactly one supported step`);
  }
  const kind = kinds[0]!;
  const stepPath = `${path}.${kind}`;
  if (kind === "click") return targetStep(step.click, stepPath, false);
  if (kind === "fill") return targetStep(step.fill, stepPath, true);
  if (kind === "waitFor") return targetStep(step.waitFor, stepPath, false);
  const route = recordAt(step.route, stepPath);
  const url = stringAt(route, "url", stepPath);
  const status = route.status;
  if (!Number.isInteger(status) || (status as number) < 100 || (status as number) > 599) {
    throw new ScenarioRecipeError(`${stepPath}.status must be an integer from 100 through 599`);
  }
  const body = stringAt(route, "body", stepPath, true);
  exactKeys(route, ["url", "status", "body"], stepPath);
  return {
    route: {
      url,
      status: status as number,
      body,
    },
  };
}

export function parseScenarioRecipe(source: string): Scenario[] {
  let value: unknown;
  try {
    value = JSON.parse(source) as unknown;
  } catch {
    throw new ScenarioRecipeError("recipe is not valid JSON");
  }
  if (!Array.isArray(value)) throw new ScenarioRecipeError("recipe must be an array");
  const labels = new Set<string>();
  return value.map((item, index) => {
    const path = `scenarios[${index}]`;
    const scenario = recordAt(item, path);
    exactKeys(scenario, ["label", "url", "steps"], path);
    const label = stringAt(scenario, "label", path);
    if (labels.has(label)) {
      throw new ScenarioRecipeError(`${path}.label duplicates ${JSON.stringify(label)}`);
    }
    labels.add(label);
    const url = stringAt(scenario, "url", path);
    if (!Array.isArray(scenario.steps)) {
      throw new ScenarioRecipeError(`${path}.steps must be an array`);
    }
    return {
      label,
      url,
      steps: scenario.steps.map((step, stepIndex) =>
        scenarioStep(step, `${path}.steps[${stepIndex}]`)),
    };
  });
}

export async function readScenarioRecipe(path: string): Promise<Scenario[]> {
  let source: string;
  try {
    source = await readFile(path, "utf8");
  } catch (error) {
    throw new ScenarioRecipeError(
      `could not read scenario recipe: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return parseScenarioRecipe(source);
}

function sameOrigin(left: URL, right: URL): boolean {
  return left.protocol === "file:"
    ? right.protocol === "file:"
    : left.origin === right.origin;
}

/** Validate and absolutize every scenario URL before a browser can start. */
export function prepareScenarios(targetUrl: string, input: readonly Scenario[]): Scenario[] {
  const target = new URL(targetUrl);
  const scenarios = parseScenarioRecipe(JSON.stringify(input));
  return scenarios.map((scenario, scenarioIndex) => {
    let url: URL;
    try {
      url = new URL(scenario.url, target);
    } catch {
      throw new ScenarioRecipeError(`scenarios[${scenarioIndex}].url must resolve to a valid URL`);
    }
    if (!sameOrigin(target, url)) {
      throw new ScenarioRecipeError(`scenarios[${scenarioIndex}].url must stay on the scan target origin`);
    }
    return {
      ...scenario,
      url: url.href,
      steps: scenario.steps.map((step, stepIndex) => {
        if (!("route" in step)) return step;
        let routeUrl: URL;
        try {
          routeUrl = new URL(step.route.url, url);
        } catch {
          throw new ScenarioRecipeError(
            `scenarios[${scenarioIndex}].steps[${stepIndex}].route.url must resolve to a valid URL`,
          );
        }
        if (!sameOrigin(url, routeUrl)) {
          throw new ScenarioRecipeError(
            `scenarios[${scenarioIndex}].steps[${stepIndex}].route.url must stay on the scenario origin`,
          );
        }
        return { route: { ...step.route, url: routeUrl.href } };
      }),
    };
  });
}

export function scenarioArtifactName(label: string): string {
  const slug = label.toLowerCase().normalize("NFKD")
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-|-$/gu, "")
    .slice(0, 48) || "scenario";
  const suffix = createHash("sha256").update(label).digest("hex").slice(0, 8);
  return `${slug}-${suffix}`;
}

export interface ScenarioStepFailure {
  index: number;
  kind: "click" | "fill" | "waitFor";
  role: string;
  name: string;
  reason: "target-not-found" | "action-not-completed";
  detail: string;
}

/** Report route installation first, followed by the interaction steps attempted in page order. */
export function attemptedScenarioSteps(
  scenario: Scenario,
  failure?: ScenarioStepFailure,
): ScenarioStep[] {
  const routes = scenario.steps.filter(
    (step): step is Extract<ScenarioStep, { route: unknown }> => "route" in step,
  );
  const interactions = scenario.steps.filter((step, index) =>
    !("route" in step) && (failure === undefined || index <= failure.index)
  );
  return [...routes, ...interactions];
}

async function installRoute(
  page: Page,
  step: Extract<ScenarioStep, { route: unknown }>,
): Promise<void> {
  await page.route(step.route.url, async (route) => {
    await route.fulfill({
      status: step.route.status,
      body: step.route.body,
      contentType: "application/json",
    });
  });
}

/** Install response fixtures and the scenario-origin boundary before navigation. */
export async function installScenarioRoutes(
  page: Page,
  scenario: Scenario,
  recordViolation: (message: string) => void,
): Promise<void> {
  for (const step of scenario.steps) {
    if ("route" in step) await installRoute(page, step);
  }
  const scenarioOrigin = new URL(scenario.url).origin;
  await page.route("**/*", async (route, request) => {
    if (
      request.isNavigationRequest() &&
      request.frame() === page.mainFrame() &&
      new URL(request.url()).origin !== scenarioOrigin
    ) {
      recordViolation(`scenario navigation blocked outside its origin: ${request.url()}`);
      await route.abort("blockedbyclient");
      return;
    }
    await route.fallback();
  });
}

export async function runScenarioSteps(
  page: Page,
  scenario: Scenario,
  timeoutMs: number,
  afterInteraction: () => Promise<void>,
): Promise<ScenarioStepFailure | undefined> {
  for (let index = 0; index < scenario.steps.length; index += 1) {
    const step = scenario.steps[index]!;
    if ("route" in step) {
      continue;
    }
    const kind = "click" in step ? "click" : "fill" in step ? "fill" : "waitFor";
    const target = "click" in step ? step.click : "fill" in step ? step.fill : step.waitFor;
    try {
      const locator = page.getByRole(
        target.role as Parameters<Page["getByRole"]>[0],
        { name: target.name },
      );
      if ("click" in step) await locator.click({ timeout: timeoutMs });
      else if ("fill" in step) await locator.fill(step.fill.value, { timeout: timeoutMs });
      else await locator.waitFor({ state: "visible", timeout: timeoutMs });
    } catch (error) {
      const locator = page.getByRole(
        target.role as Parameters<Page["getByRole"]>[0],
        { name: target.name },
      );
      const matchCount = await locator.count().catch(() => -1);
      return {
        index,
        kind,
        role: target.role,
        name: target.name,
        reason: matchCount === 0 ? "target-not-found" : "action-not-completed",
        detail: error instanceof Error ? error.message : String(error),
      };
    }
    await afterInteraction();
  }
  return undefined;
}
