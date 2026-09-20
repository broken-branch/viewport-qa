import { describe, expect, it } from "vitest";
import { extractChromiumPdfText } from "./pdf-inspection.js";

function encode(value: string): string {
  return [...value].map((character) => {
    if (character === " ") return "0001";
    if (character === "-") return "0002";
    if (character === "1") return "0200";
    if (character === "2") return "0201";
    return (0x100 + character.codePointAt(0)! - 0x41).toString(16).padStart(4, "0");
  }).join("");
}

describe("Chromium PDF text inspection", () => {
  it("decodes multibyte Tj and TJ text through scalar and array bfrange mappings", () => {
    const cmap = `begincmap
1 begincodespacerange
<0000> <FFFF>
endcodespacerange
2 beginbfchar
<0001> <0020>
<0002> <002D>
endbfchar
2 beginbfrange
<0100> <0119> <0041>
<0200> <0201> [<0031> <0032>]
endbfrange
endcmap`;
    const content = `BT /F1 12 Tf <${encode("VISUAL QA HANDOFF")}> Tj [<${encode(" VQ-")}> -20 <${encode("AUDIT 12")}>] TJ ET`;
    const pdf = Buffer.from(`%PDF-1.7
4 0 obj << /Type /Font /ToUnicode 5 0 R >> endobj
5 0 obj << /Length ${cmap.length} >> stream
${cmap}
endstream
endobj
6 0 obj << /Type /Page /Resources << /Font << /F1 4 0 R >> >> /Contents 7 0 R >> endobj
7 0 obj << /Length ${content.length} >> stream
${content}
endstream
endobj
%%EOF`, "latin1");
    const extracted = extractChromiumPdfText(pdf);
    expect(extracted).toContain("VISUAL QA HANDOFF");
    expect(extracted).toContain("VQ-AUDIT 12");
    expect(extracted).toMatch(/\bVQ-AUDIT\b/u);
  });

  it("resolves repeated font names through each page and indirect resource dictionary", () => {
    const firstCmap = `begincmap
1 begincodespacerange
<00> <FF>
endcodespacerange
4 beginbfchar
<01> <0056>
<02> <0049>
<03> <0053>
<04> <0055>
endbfchar
endcmap`;
    const secondCmap = `begincmap
1 begincodespacerange
<00> <FF>
endcodespacerange
8 beginbfchar
<01> <0056>
<02> <0051>
<03> <002D>
<04> <0041>
<05> <0055>
<06> <0044>
<07> <0049>
<08> <0054>
endbfchar
endcmap`;
    const pdf = Buffer.from(`%PDF-1.7
4 0 obj << /Type /Font /ToUnicode 5 0 R >> endobj
5 0 obj << >> stream
${firstCmap}
endstream
endobj
6 0 obj << /Type /Page /Resources << /Font << /F1 4 0 R >> >> /Contents 7 0 R >> endobj
7 0 obj << >> stream
BT /F1 12 Tf <0102030504> Tj ET
endstream
endobj
8 0 obj << /Type /Font /ToUnicode 9 0 R >> endobj
9 0 obj << >> stream
${secondCmap}
endstream
endobj
10 0 obj << /Font 11 0 R >> endobj
11 0 obj << /F1 8 0 R >> endobj
12 0 obj << /Type /Page /Resources 10 0 R /Contents 13 0 R >> endobj
13 0 obj << >> stream
BT /F1 12 Tf [<010203> -20 <0405060708>] TJ ET
endstream
endobj
%%EOF`, "latin1");
    const extracted = extractChromiumPdfText(pdf);
    expect(extracted).toContain("VISU");
    expect(extracted).toContain("VQ-AUDIT");
  });

  it("consumes an unknown glyph at its declared width without decoding a mapped suffix", () => {
    const cmap = `begincmap
2 begincodespacerange
<00> <FF>
<0100> <01FF>
endcodespacerange
2 beginbfchar
<FF> <0058>
<0100> <0041>
endbfchar
endcmap`;
    const pdf = Buffer.from(`%PDF-1.7
4 0 obj << /Type /Font /ToUnicode 5 0 R >> endobj
5 0 obj << >> stream
${cmap}
endstream
endobj
6 0 obj << /Type /Page /Resources << /Font << /F1 4 0 R >> >> /Contents 7 0 R >> endobj
7 0 obj << >> stream
BT /F1 12 Tf <01FF> Tj ET
endstream
endobj
%%EOF`, "latin1");
    expect(extractChromiumPdfText(pdf)).toBe("");
  });
});
