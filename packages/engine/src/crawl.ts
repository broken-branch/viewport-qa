export const DEFAULT_MAX_PAGES = 10;
export const HARD_MAX_PAGES = 50;
export const DEFAULT_MAX_DEPTH = 2;
export const HARD_MAX_DEPTH = 10;

const BINARY_EXTENSIONS = new Set([
  ".7z",
  ".avi",
  ".bin",
  ".bmp",
  ".css",
  ".csv",
  ".doc",
  ".docx",
  ".dmg",
  ".eot",
  ".exe",
  ".gif",
  ".gz",
  ".ico",
  ".jpeg",
  ".jpg",
  ".js",
  ".json",
  ".m4a",
  ".mov",
  ".mp3",
  ".mp4",
  ".mpeg",
  ".ogg",
  ".otf",
  ".pdf",
  ".png",
  ".ppt",
  ".pptx",
  ".rar",
  ".rss",
  ".svg",
  ".tar",
  ".tgz",
  ".tif",
  ".tiff",
  ".ttf",
  ".wav",
  ".webm",
  ".webp",
  ".woff",
  ".woff2",
  ".xls",
  ".xlsx",
  ".xml",
  ".zip",
]);

function isObviousBinary(url: URL): boolean {
  const finalSegment = url.pathname.split("/").at(-1) ?? "";
  const dot = finalSegment.lastIndexOf(".");
  return dot >= 0 && BINARY_EXTENSIONS.has(finalSegment.slice(dot).toLowerCase());
}

export function normalizeCrawlLinks(
  pageUrl: string,
  startOrigin: string,
  hrefs: readonly string[],
): string[] {
  const links: string[] = [];
  const seen = new Set<string>();
  for (const href of hrefs) {
    let url: URL;
    try {
      url = new URL(href, pageUrl);
    } catch {
      continue;
    }
    if (!/^https?:$/.test(url.protocol) || url.origin !== startOrigin) continue;
    url.hash = "";
    if (isObviousBinary(url)) continue;
    const normalized = url.href;
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    links.push(normalized);
  }
  return links;
}

export interface CrawlVisit<T> {
  value: T;
  hrefs: readonly string[];
  finalUrl: string;
}

export type ClaimCrawlFinalUrl = (finalUrl: string) => string;

class RejectedCrawlFinalUrlError extends Error {
  constructor(
    message: string,
    readonly finalUrl: string,
  ) {
    super(message);
  }
}

class DuplicateCrawlFinalUrlError extends Error {}

export type CrawlResult<T> =
  | { url: string; depth: number; status: "success"; value: T }
  | { url: string; depth: number; status: "failed"; error: string };

export async function crawlSameOrigin<T>(
  startUrl: string,
  limits: { maxPages: number; maxDepth: number },
  visit: (
    url: string,
    depth: number,
    index: number,
    claimFinalUrl: ClaimCrawlFinalUrl,
  ) => Promise<CrawlVisit<T>>,
): Promise<CrawlResult<T>[]> {
  const start = new URL(startUrl);
  if (!/^https?:$/.test(start.protocol)) {
    throw new Error("Multi-page crawling requires an HTTP(S) start URL");
  }
  start.hash = "";

  const queue: Array<{ url: string; depth: number }> = [
    { url: start.href, depth: 0 },
  ];
  const seen = new Set([start.href]);
  const visitedFinalUrls = new Set<string>();
  const results: CrawlResult<T>[] = [];

  for (let cursor = 0; cursor < queue.length && results.length < limits.maxPages; cursor += 1) {
    const item = queue[cursor]!;
    if (visitedFinalUrls.has(item.url)) continue;
    let claimedFinalUrl: string | undefined;
    let clientNavigationSourceUrl: string | undefined;
    const claimFinalUrl: ClaimCrawlFinalUrl = (rawFinalUrl) => {
      let final: URL;
      try {
        final = new URL(rawFinalUrl);
      } catch {
        throw new RejectedCrawlFinalUrlError(
          `Invalid final URL after navigation: ${rawFinalUrl}`,
          rawFinalUrl,
        );
      }
      final.hash = "";
      if (!/^https?:$/.test(final.protocol) || final.origin !== start.origin) {
        throw new RejectedCrawlFinalUrlError(
          `Off-origin redirect blocked: ${final.href}`,
          final.href,
        );
      }
      if (claimedFinalUrl === final.href) return final.href;
      if (claimedFinalUrl !== undefined) {
        if (clientNavigationSourceUrl === final.href) return final.href;
        if (clientNavigationSourceUrl === undefined) {
          if (visitedFinalUrls.has(final.href)) {
            throw new DuplicateCrawlFinalUrlError(
              `Final URL already scanned: ${final.href}`,
            );
          }
          visitedFinalUrls.delete(claimedFinalUrl);
          clientNavigationSourceUrl = claimedFinalUrl;
          visitedFinalUrls.add(final.href);
          claimedFinalUrl = final.href;
          return final.href;
        }
        throw new RejectedCrawlFinalUrlError(
          `Navigation final URL changed from ${claimedFinalUrl} to ${final.href}`,
          final.href,
        );
      }
      if (visitedFinalUrls.has(final.href)) {
        throw new DuplicateCrawlFinalUrlError(
          `Final URL already scanned: ${final.href}`,
        );
      }
      visitedFinalUrls.add(final.href);
      claimedFinalUrl = final.href;
      return final.href;
    };
    try {
      const visited = await visit(
        item.url,
        item.depth,
        results.length,
        claimFinalUrl,
      );
      const finalUrl = claimFinalUrl(visited.finalUrl);
      seen.add(finalUrl);
      results.push({
        url: finalUrl,
        depth: item.depth,
        status: "success",
        value: visited.value,
      });
      if (item.depth >= limits.maxDepth) continue;
      for (const link of normalizeCrawlLinks(finalUrl, start.origin, visited.hrefs)) {
        if (queue.length >= limits.maxPages) break;
        if (seen.has(link)) continue;
        seen.add(link);
        queue.push({ url: link, depth: item.depth + 1 });
      }
    } catch (error) {
      if (error instanceof DuplicateCrawlFinalUrlError) continue;
      if (
        clientNavigationSourceUrl !== undefined &&
        claimedFinalUrl !== undefined
      ) {
        visitedFinalUrls.delete(claimedFinalUrl);
        visitedFinalUrls.add(clientNavigationSourceUrl);
      }
      if (item.depth === 0) throw error;
      results.push({
        url:
          error instanceof RejectedCrawlFinalUrlError
            ? error.finalUrl
            : (claimedFinalUrl ?? item.url),
        depth: item.depth,
        status: "failed",
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return results;
}
