export const BEHAVIOUR_LIMITS = {
  distinctPerKind: 200,
  occurrencesPerIdentity: 20,
  fieldLength: 2_048,
} as const;

export interface CaptureOmissions {
  consoleMessages: number;
  failedRequests: number;
  storageChanges: number;
}
export function boundedField(value: string): string {
  if (value.length <= BEHAVIOUR_LIMITS.fieldLength) return value;
  return `${value.slice(0, BEHAVIOUR_LIMITS.fieldLength - 1)}…`;
}

export class BoundedRecords<T> {
  readonly records: T[] = [];
  private readonly counts = new Map<string, number>();

  constructor(
    private readonly omitted: CaptureOmissions,
    private readonly omissionKey: keyof CaptureOmissions,
  ) {}

  add(identity: string, record: T): void {
    const count = this.counts.get(identity);
    if (count === undefined && this.counts.size >= BEHAVIOUR_LIMITS.distinctPerKind) {
      this.omit();
      return;
    }
    if ((count ?? 0) >= BEHAVIOUR_LIMITS.occurrencesPerIdentity) {
      this.omit();
      return;
    }
    this.counts.set(identity, (count ?? 0) + 1);
    this.records.push(record);
  }

  private omit(): void {
    this.omitted[this.omissionKey] = Math.min(
      Number.MAX_SAFE_INTEGER,
      this.omitted[this.omissionKey] + 1,
    );
  }
}

export function sanitizedBehaviourUrl(rawUrl: string, pageUrl: string): string {
  try {
    const page = new URL(pageUrl);
    const url = new URL(rawUrl, page);
    if (page.origin === "null" || url.origin === "null" || url.origin !== page.origin) {
      url.search = "";
    }
    return boundedField(url.href);
  } catch {
    const query = rawUrl.indexOf("?");
    const fragment = rawUrl.indexOf("#");
    const end = Math.min(
      query < 0 ? rawUrl.length : query,
      fragment < 0 ? rawUrl.length : fragment,
    );
    return boundedField(`${rawUrl.slice(0, end)}[unparseable-url]`);
  }
}
