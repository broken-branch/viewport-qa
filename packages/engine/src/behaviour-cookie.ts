import type { BehaviourFinding } from "@vqa/contract";
import { boundedField } from "./behaviour-limits.js";

export type StorageFinding = Extract<BehaviourFinding, { kind: "storage-change" }>;

export function cookieHeaderFinding(
  header: string,
  responseUrl: string,
): StorageFinding | undefined {
  const parts = header.split(";");
  const nameValue = parts.shift() ?? "";
  const equals = nameValue.indexOf("=");
  const name = boundedField((equals < 0 ? nameValue : nameValue.slice(0, equals)).trim());
  if (!name) return undefined;
  const attributes = new Map<string, string>();
  for (const rawPart of parts) {
    const part = rawPart.trim();
    const separator = part.indexOf("=");
    attributes.set(
      (separator < 0 ? part : part.slice(0, separator)).trim().toLowerCase(),
      separator < 0 ? "" : boundedField(part.slice(separator + 1).trim()),
    );
  }
  const url = new URL(responseUrl);
  const finalSlash = url.pathname.lastIndexOf("/");
  const maxAge = Number(attributes.get("max-age"));
  const expiresText = attributes.get("expires");
  const rawSameSite = attributes.get("samesite")?.toLowerCase();
  return {
    kind: "storage-change",
    storage: "cookie",
    name,
    attributes: {
      domain: boundedField(attributes.get("domain")?.toLowerCase() || url.hostname),
      path: boundedField(attributes.get("path") || (finalSlash <= 0 ? "/" : url.pathname.slice(0, finalSlash))),
      expires: attributes.has("max-age") && Number.isFinite(maxAge)
        ? maxAge <= 0 ? 0 : Date.now() / 1_000 + maxAge
        : expiresText && Number.isFinite(Date.parse(expiresText)) ? Date.parse(expiresText) / 1_000 : -1,
      httpOnly: attributes.has("httponly"),
      secure: attributes.has("secure"),
      sameSite: rawSameSite === "strict" ? "Strict" : rawSameSite === "none" ? "None" : "Lax",
    },
  };
}
