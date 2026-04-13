export type ParseProvider = "llama-cloud";

export interface NormalizedParseResult {
  provider: ParseProvider;
  text: string;
  markdown: string;
  pages?: unknown[];
  tables?: unknown[];
  entities?: unknown[];
  rawResult: unknown;
}

export interface ParseInvocationContext {
  documentId?: string;
  jobId?: string;
  mimeType?: string | null;
}
