export interface BrowserDownloadDisclosure {
  supported: boolean;
  bytes?: number;
  url?: string;
  networkOrigin?: string;
}

const DOWNLOADS: Partial<Record<NodeJS.Platform, Partial<Record<string, { bytes: number; url: string }>>>> = {
  win32: { x64: { bytes: 192_511_857, url: "https://cdn.playwright.dev/builds/cft/149.0.7827.55/win64/chrome-win64.zip" } },
  darwin: { arm64: { bytes: 179_277_110, url: "https://cdn.playwright.dev/builds/cft/149.0.7827.55/mac-arm64/chrome-mac-arm64.zip" } },
  linux: { x64: { bytes: 185_646_494, url: "https://cdn.playwright.dev/builds/cft/149.0.7827.55/linux64/chrome-linux64.zip" } },
};

export function browserDownloadDisclosure(
  platform: NodeJS.Platform = process.platform,
  architecture: string = process.arch,
  environment: NodeJS.ProcessEnv = process.env,
): BrowserDownloadDisclosure {
  const download = DOWNLOADS[platform]?.[architecture];
  if (!download) return { supported: false };
  const mirror = environment.VQA_BROWSER_MIRROR;
  if (!mirror) return { supported: true, ...download, networkOrigin: new URL(download.url).origin };
  try {
    const parsed = new URL(mirror);
    return {
      supported: true,
      ...download,
      ...(parsed.protocol === "https:" && !parsed.username && !parsed.password ? { networkOrigin: parsed.origin } : {}),
    };
  } catch {
    return { supported: true, ...download };
  }
}
