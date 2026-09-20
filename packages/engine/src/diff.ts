import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { PNG } from "pngjs";
import type {
  CaptureDiff,
  ChangedRegion,
  Report,
  RunComparison,
} from "@vqa/contract";

const REGION_TILE_SIZE = 4;

interface DecodedCapture {
  width: number;
  height: number;
  data: Buffer;
}

async function readPng(path: string): Promise<DecodedCapture> {
  return PNG.sync.read(await readFile(path));
}

function pixelChanged(
  current: DecodedCapture,
  baseline: DecodedCapture,
  x: number,
  y: number,
): boolean {
  if (
    x >= current.width ||
    y >= current.height ||
    x >= baseline.width ||
    y >= baseline.height
  ) {
    return true;
  }
  const currentOffset = (y * current.width + x) * 4;
  const baselineOffset = (y * baseline.width + x) * 4;
  for (let channel = 0; channel < 4; channel += 1) {
    if (current.data[currentOffset + channel] !== baseline.data[baselineOffset + channel]) {
      return true;
    }
  }
  return false;
}

function regionsFromTiles(
  tilePixels: Uint32Array,
  tilesWide: number,
  width: number,
  height: number,
): ChangedRegion[] {
  const seen = new Uint8Array(tilePixels.length);
  const regions: ChangedRegion[] = [];
  for (let start = 0; start < tilePixels.length; start += 1) {
    if (seen[start] || tilePixels[start] === 0) continue;
    const queue = [start];
    seen[start] = 1;
    let minX = tilesWide;
    let minY = Math.ceil(height / REGION_TILE_SIZE);
    let maxX = 0;
    let maxY = 0;
    let changedPixels = 0;
    for (let cursor = 0; cursor < queue.length; cursor += 1) {
      const index = queue[cursor]!;
      const x = index % tilesWide;
      const y = Math.floor(index / tilesWide);
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
      changedPixels += tilePixels[index]!;
      const neighbours: ReadonlyArray<readonly [number, number]> = [
        [x - 1, y],
        [x + 1, y],
        [x, y - 1],
        [x, y + 1],
      ];
      for (const [nextX, nextY] of neighbours) {
        if (nextX < 0 || nextX >= tilesWide || nextY < 0) continue;
        const next = nextY * tilesWide + nextX;
        if (next >= tilePixels.length || seen[next] || tilePixels[next] === 0) continue;
        seen[next] = 1;
        queue.push(next);
      }
    }
    const x = minX * REGION_TILE_SIZE;
    const y = minY * REGION_TILE_SIZE;
    regions.push({
      x,
      y,
      width: Math.min(width, (maxX + 1) * REGION_TILE_SIZE) - x,
      height: Math.min(height, (maxY + 1) * REGION_TILE_SIZE) - y,
      changedPixels,
    });
  }
  return regions;
}

function diffCaptures(
  target: string,
  current: DecodedCapture,
  baseline: DecodedCapture,
): CaptureDiff {
  const width = Math.max(current.width, baseline.width);
  const height = Math.max(current.height, baseline.height);
  const tilesWide = Math.ceil(width / REGION_TILE_SIZE);
  const tilesHigh = Math.ceil(height / REGION_TILE_SIZE);
  const tilePixels = new Uint32Array(tilesWide * tilesHigh);
  let changedPixels = 0;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (!pixelChanged(current, baseline, x, y)) continue;
      changedPixels += 1;
      const tile = Math.floor(y / REGION_TILE_SIZE) * tilesWide + Math.floor(x / REGION_TILE_SIZE);
      tilePixels[tile] = tilePixels[tile]! + 1;
    }
  }
  const totalPixels = width * height;
  const dimensionsMatch =
    current.width === baseline.width && current.height === baseline.height;
  return {
    target,
    status:
      changedPixels === 0
        ? "identical"
        : dimensionsMatch
          ? "changed"
          : "dimension-mismatch",
    score: totalPixels === 0 ? 0 : changedPixels / totalPixels,
    changedPixels,
    totalPixels,
    changedRegions: regionsFromTiles(tilePixels, tilesWide, width, height),
  };
}

function missingCapture(
  target: string,
  status: "missing-baseline" | "missing-current",
  capture: DecodedCapture,
): CaptureDiff {
  const totalPixels = capture.width * capture.height;
  return {
    target,
    status,
    score: 1,
    changedPixels: totalPixels,
    totalPixels,
    changedRegions: [
      {
        x: 0,
        y: 0,
        width: capture.width,
        height: capture.height,
        changedPixels: totalPixels,
      },
    ],
  };
}

export async function compareRunCaptures(
  current: Report,
  currentDir: string,
  baselineDir: string,
): Promise<RunComparison> {
  const baseline = JSON.parse(
    await readFile(join(baselineDir, "issues.json"), "utf8"),
  ) as Report;
  const hasMultiplePages = (report: Report): boolean =>
    new Set(
      report.viewports
        .map((viewport) => viewport.pageUrl)
        .filter((url): url is string => url !== undefined),
    ).size > 1;
  const matchByPageUrl = hasMultiplePages(current) || hasMultiplePages(baseline);
  const targetFor = (viewport: Report["viewports"][number]): string =>
    `${matchByPageUrl && viewport.pageUrl ? `${viewport.pageUrl} @ ` : ""}${
      viewport.scenarioLabel ? `${viewport.scenarioLabel} @ ` : ""
    }${viewport.viewport.label}`;
  const currentByTarget = new Map(
    current.viewports.map((viewport) => [targetFor(viewport), viewport]),
  );
  const baselineByTarget = new Map(
    baseline.viewports.map((viewport) => [targetFor(viewport), viewport]),
  );
  const targets = [
    ...currentByTarget.keys(),
    ...[...baselineByTarget.keys()].filter((target) => !currentByTarget.has(target)),
  ];
  const results: CaptureDiff[] = [];
  for (const target of targets) {
    const currentViewport = currentByTarget.get(target);
    const baselineViewport = baselineByTarget.get(target);
    if (currentViewport && baselineViewport) {
      const [currentCapture, baselineCapture] = await Promise.all([
        readPng(join(currentDir, currentViewport.screenshot)),
        readPng(join(baselineDir, baselineViewport.screenshot)),
      ]);
      results.push(diffCaptures(target, currentCapture, baselineCapture));
    } else if (currentViewport) {
      results.push(
        missingCapture(
          target,
          "missing-baseline",
          await readPng(join(currentDir, currentViewport.screenshot)),
        ),
      );
    } else if (baselineViewport) {
      results.push(
        missingCapture(
          target,
          "missing-current",
          await readPng(join(baselineDir, baselineViewport.screenshot)),
        ),
      );
    }
  }
  return {
    baseline: {
      url: baseline.url,
      createdAt: baseline.createdAt,
      ...(baseline.baseline ? { markedAt: baseline.baseline.markedAt } : {}),
    },
    results,
    changedTargetCount: results.filter((result) => result.status !== "identical")
      .length,
  };
}
