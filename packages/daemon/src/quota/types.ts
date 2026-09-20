/** One number per harness for the router (fraction left, 0..1) plus what the panel shows. */

export type QuotaReading = {
  readonly harness: string;
  readonly remaining: number | null;   // 0..1, null = unknown
  readonly detail: Readonly<Record<string, unknown>>;
  readonly source: string;
  readonly fetchedAt: number;
  readonly error: string | null;
};

export interface QuotaProvider {
  readonly harness: string;
  read(): Promise<Omit<QuotaReading, "harness" | "fetchedAt">>;
}
