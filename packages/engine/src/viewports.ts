import type { ViewportSpec } from "@vqa/contract";

/** Common resolutions; DPR variants are opt-in via the spec syntax (WxH@DPR). */
export const DEFAULT_VIEWPORT_SPECS = [
  "360x800",
  "390x844",
  "390x844@3",
  "768x1024",
  "1280x800",
  "1440x900",
  "1920x1080",
  "2560x1440",
] as const;

export function parseViewport(spec: string): ViewportSpec {
  const match = /^(\d+)x(\d+)(?:@(\d+(?:\.\d+)?))?$/.exec(spec.trim());
  if (!match) {
    throw new Error(
      `Invalid viewport spec "${spec}" (expected WIDTHxHEIGHT or WIDTHxHEIGHT@DPR, e.g. 390x844@3)`,
    );
  }
  const width = Number(match[1]);
  const height = Number(match[2]);
  const deviceScaleFactor = match[3] ? Number(match[3]) : 1;
  if (width < 100 || height < 100 || width > 10000 || height > 10000) {
    throw new Error(`Viewport ${spec} out of supported range (100..10000)`);
  }
  return {
    width,
    height,
    deviceScaleFactor,
    label: `${width}x${height}@${deviceScaleFactor}`,
  };
}

export function parseViewportList(list: string | undefined): ViewportSpec[] {
  const specs = list
    ? list
        .split(",")
        .map((entry) => entry.trim())
        .filter(Boolean)
    : [...DEFAULT_VIEWPORT_SPECS];
  if (specs.length === 0) throw new Error("Viewport list is empty");
  return specs.map(parseViewport);
}
