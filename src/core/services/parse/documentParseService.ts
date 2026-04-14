import {
  isLlamaCloudConfigured,
  parseDocumentWithLlamaCloud,
} from "./llamaParseService.js";
import type { NormalizedParseResult, ParseInvocationContext } from "./types.js";

export type DocumentParseProvider = "llama-cloud";

const ACTIVE_PARSE_PROVIDER: DocumentParseProvider = "llama-cloud";

export function getActiveParseProvider(): DocumentParseProvider {
  return ACTIVE_PARSE_PROVIDER;
}

export function canUseSharedParser(): boolean {
  if (ACTIVE_PARSE_PROVIDER === "llama-cloud") {
    return isLlamaCloudConfigured();
  }
  return false;
}

export async function parseDocumentWithSharedService(
  filePath: string,
  context?: ParseInvocationContext,
): Promise<NormalizedParseResult> {
  if (ACTIVE_PARSE_PROVIDER === "llama-cloud") {
    return parseDocumentWithLlamaCloud(filePath, context);
  }

  throw new Error(`Unsupported parse provider: ${ACTIVE_PARSE_PROVIDER}`);
}
