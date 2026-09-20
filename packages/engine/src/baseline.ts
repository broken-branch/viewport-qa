import { cp, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Report } from "@vqa/contract";
import { renderReportHtml } from "./report-html.js";
import { writeReviewArtifacts } from "./review-manifest.js";
import { replaceReportTransaction } from "./report-transaction.js";

export async function markRunAsBaseline(reportDir: string): Promise<Report> {
  return replaceReportTransaction(reportDir, async (staging) => {
    for (const entry of await readdir(reportDir)) {
      await cp(join(reportDir, entry), join(staging, entry), {
        recursive: true,
        errorOnExist: true,
      });
    }
    const report = JSON.parse(
      await readFile(join(staging, "issues.json"), "utf8"),
    ) as Report;
    const marked: Report = {
      ...report,
      baseline: { markedAt: new Date().toISOString() },
    };
    await writeFile(join(staging, "issues.json"), `${JSON.stringify(marked, null, 2)}\n`);
    await writeReviewArtifacts(marked, staging, renderReportHtml);
    return marked;
  });
}
