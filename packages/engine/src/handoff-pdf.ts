import { compatibleBrowserExecutablePath } from "./browser-manager.js";
import { launchSandboxedChromium } from "./browser-launch.js";

export interface HumanHandoffPdfImage {
  label: string;
  mediaType: "image/png" | "image/jpeg";
  base64: string;
}

export interface RenderHumanHandoffPdfOptions {
  content: string;
  images: HumanHandoffPdfImage[];
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function normalizePdfMetadata(bytes: Buffer): Buffer {
  const source = bytes.toString("latin1");
  const normalized = source.replace(
    /\/(CreationDate|ModDate) \(D:\d{14}[+-]\d{2}'\d{2}'\)/gu,
    "/$1 (D:20000101000000+00'00')",
  );
  if (normalized === source) throw new Error("PDF metadata could not be normalized");
  return Buffer.from(normalized, "latin1");
}

export async function renderHumanHandoffPdf(
  options: RenderHumanHandoffPdfOptions,
): Promise<Buffer> {
  const figures = options.images.map(
    (image) =>
      `<figure><figcaption>${escapeHtml(image.label)}</figcaption><img src="data:${image.mediaType};base64,${image.base64}" alt="${escapeHtml(image.label)}"></figure>`,
  );
  const html = `<!doctype html><html><head><meta charset="utf-8"><style>
    @page{size:A4;margin:16mm}*{box-sizing:border-box}body{margin:0;color:#18202a;background:#fff;font:11pt/1.5 Arial,sans-serif}
    pre{margin:0 0 20px;white-space:pre-wrap;overflow-wrap:anywhere;font:11pt/1.5 Arial,sans-serif}
    h2{margin:24px 0 12px;font-size:16pt;break-after:avoid;page-break-after:avoid}figure{break-inside:avoid;page-break-inside:avoid;margin:0 0 22px;padding-top:8px;border-top:1px solid #ccd3da}
    figcaption{margin:0 0 8px;font-weight:700}img{display:block;width:auto;height:auto;max-width:100%;max-height:230mm;object-fit:contain;object-position:left top}
  </style></head><body><pre>${escapeHtml(options.content)}</pre><h2>Affected screenshots</h2>${figures.join("")}</body></html>`;
  const browser = await launchSandboxedChromium({
    headless: true,
    executablePath: await compatibleBrowserExecutablePath(),
  });
  try {
    const page = await browser.newPage();
    await page.route(/^https?:/u, (route) => route.abort());
    await page.setContent(html, { waitUntil: "load" });
    return normalizePdfMetadata(
      Buffer.from(await page.pdf({ format: "A4", printBackground: true })),
    );
  } finally {
    await browser.close();
  }
}
