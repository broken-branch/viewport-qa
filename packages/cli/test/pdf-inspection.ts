import { inflateSync } from "node:zlib";

interface PdfStream { objectId: string; dictionary: string; content: string }
interface PdfObject { objectId: string; body: string }
interface CodeRange { width: number; first: number; last: number }
interface PdfCmap { glyphs: Map<string, string>; codeRanges: CodeRange[] }

function pdfObjects(source: string): PdfObject[] {
  return [...source.matchAll(/(\d+)\s+\d+\s+obj\b([\s\S]*?)endobj/gu)].map((match) => ({
    objectId: match[1]!,
    body: match[2]!,
  }));
}

function pdfStreams(bytes: Buffer): PdfStream[] {
  const source = bytes.toString("latin1");
  const streams: PdfStream[] = [];
  for (const object of pdfObjects(source)) {
    const marker = /stream\r?\n/gu.exec(object.body);
    if (!marker) continue;
    const start = marker.index + marker[0].length;
    const end = object.body.indexOf("\nendstream", start);
    if (end < 0) break;
    const payload = Buffer.from(object.body.slice(start, end), "latin1");
    let content: string;
    try { content = inflateSync(payload).toString("latin1"); }
    catch { content = payload.toString("latin1"); }
    streams.push({ objectId: object.objectId, dictionary: object.body.slice(0, marker.index), content });
  }
  return streams;
}

function utf16BigEndian(hex: string): string {
  let value = "";
  for (let offset = 0; offset < hex.length; offset += 4) {
    value += String.fromCharCode(Number.parseInt(hex.slice(offset, offset + 4), 16));
  }
  return value;
}

function parseCmap(cmap: string): PdfCmap {
  const glyphs = new Map<string, string>();
  const codeRanges: CodeRange[] = [];
  for (const block of cmap.matchAll(/begincodespacerange([\s\S]*?)endcodespacerange/gu)) {
    for (const match of block[1]!.matchAll(/<([\dA-Fa-f]+)>\s*<([\dA-Fa-f]+)>/gu)) {
      codeRanges.push({
        width: match[1]!.length,
        first: Number.parseInt(match[1]!, 16),
        last: Number.parseInt(match[2]!, 16),
      });
    }
  }
  for (const block of cmap.matchAll(/beginbfchar([\s\S]*?)endbfchar/gu)) {
    for (const match of block[1]!.matchAll(/<([\dA-Fa-f]+)>\s*<([\dA-Fa-f]+)>/gu)) {
      glyphs.set(match[1]!.toUpperCase(), utf16BigEndian(match[2]!));
    }
  }
  for (const block of cmap.matchAll(/beginbfrange([\s\S]*?)endbfrange/gu)) {
    const body = block[1]!;
    for (const match of body.matchAll(/<([\dA-Fa-f]+)>\s*<([\dA-Fa-f]+)>\s*<([\dA-Fa-f]+)>/gu)) {
      const first = Number.parseInt(match[1]!, 16);
      const last = Number.parseInt(match[2]!, 16);
      const unicodeFirst = Number.parseInt(match[3]!, 16);
      for (let code = first; code <= last; code += 1) {
        const key = code.toString(16).toUpperCase().padStart(match[1]!.length, "0");
        glyphs.set(key, String.fromCharCode(unicodeFirst + code - first));
      }
    }
    for (const match of body.matchAll(/<([\dA-Fa-f]+)>\s*<([\dA-Fa-f]+)>\s*\[((?:\s*<[\dA-Fa-f]+>)+)\]/gu)) {
      const first = Number.parseInt(match[1]!, 16);
      const last = Number.parseInt(match[2]!, 16);
      const values = [...match[3]!.matchAll(/<([\dA-Fa-f]+)>/gu)].map((item) => utf16BigEndian(item[1]!));
      for (let code = first; code <= last && code - first < values.length; code += 1) {
        const key = code.toString(16).toUpperCase().padStart(match[1]!.length, "0");
        glyphs.set(key, values[code - first]!);
      }
    }
  }
  if (codeRanges.length === 0) {
    for (const width of new Set([...glyphs.keys()].map((key) => key.length))) {
      codeRanges.push({ width, first: 0, last: Number.parseInt("F".repeat(width), 16) });
    }
  }
  codeRanges.sort((left, right) => right.width - left.width);
  return { glyphs, codeRanges };
}

function decodeGlyphString(encoded: string, cmap: PdfCmap): string {
  let decoded = "";
  for (let offset = 0; offset < encoded.length;) {
    const range = cmap.codeRanges.find((candidate) => {
      if (offset + candidate.width > encoded.length) return false;
      const code = Number.parseInt(encoded.slice(offset, offset + candidate.width), 16);
      return code >= candidate.first && code <= candidate.last;
    });
    if (!range) { offset += 2; continue; }
    decoded += cmap.glyphs.get(encoded.slice(offset, offset + range.width).toUpperCase()) ?? "";
    offset += range.width;
  }
  return decoded;
}

function resourceCmaps(
  pageBody: string,
  objects: Map<string, string>,
  fontCmaps: Map<string, PdfCmap>,
): Map<string, PdfCmap> {
  const resourceReference = /\/Resources\s+(\d+)\s+\d+\s+R/u.exec(pageBody);
  let resources = resourceReference ? objects.get(resourceReference[1]!) ?? "" : pageBody;
  const fontReference = /\/Font\s+(\d+)\s+\d+\s+R/u.exec(resources);
  if (fontReference) resources = `${resources}\n${objects.get(fontReference[1]!) ?? ""}`;
  const result = new Map<string, PdfCmap>();
  for (const match of resources.matchAll(/\/(F[\w.-]+)\s+(\d+)\s+\d+\s+R/gu)) {
    const cmap = fontCmaps.get(match[2]!);
    if (cmap) result.set(match[1]!, cmap);
  }
  return result;
}

/** Dependency-free inspection of the Chromium PDF subset emitted by Playwright. */
export function extractChromiumPdfText(bytes: Buffer): string {
  const source = bytes.toString("latin1");
  const streams = pdfStreams(bytes);
  const objectsList = pdfObjects(source);
  const objects = new Map(objectsList.map((object) => [object.objectId, object.body]));
  const cmaps = new Map(streams.filter((stream) => stream.content.includes("begincmap")).map((stream) => [stream.objectId, parseCmap(stream.content)]));
  const fontCmaps = new Map<string, PdfCmap>();
  for (const object of objectsList) {
    const match = /\/ToUnicode\s+(\d+)\s+\d+\s+R/u.exec(object.body);
    const cmap = match ? cmaps.get(match[1]!) : undefined;
    if (cmap) fontCmaps.set(object.objectId, cmap);
  }
  const contentCmaps = new Map<string, Map<string, PdfCmap>>();
  for (const page of objectsList.filter((object) => /\/Type\s*\/Page\b/u.test(object.body))) {
    const resources = resourceCmaps(page.body, objects, fontCmaps);
    const contents = /\/Contents\s*\[([^\]]*)\]/u.exec(page.body)?.[1] ??
      /\/Contents\s+(\d+\s+\d+\s+R)/u.exec(page.body)?.[1] ?? "";
    for (const match of contents.matchAll(/(\d+)\s+\d+\s+R/gu)) contentCmaps.set(match[1]!, resources);
  }
  let text = "";
  for (const stream of streams.filter((candidate) => /\bBT\b/u.test(candidate.content))) {
    const resourceFonts = contentCmaps.get(stream.objectId);
    if (!resourceFonts) continue;
    for (const block of stream.content.matchAll(/BT([\s\S]*?)ET/gu)) {
      let current: PdfCmap | undefined;
      const operator = /\/(F[\w.-]+)\s+[\d.]+\s+Tf|<([\dA-Fa-f]+)>\s*Tj|\[([^\]]*)\]\s*TJ/gu;
      for (const match of block[1]!.matchAll(operator)) {
        if (match[1]) current = resourceFonts.get(match[1]);
        else if (match[2] && current) text += decodeGlyphString(match[2], current);
        else if (match[3] && current) {
          for (const glyphs of match[3].matchAll(/<([\dA-Fa-f]+)>/gu)) text += decodeGlyphString(glyphs[1]!, current);
        }
      }
    }
  }
  return text;
}
