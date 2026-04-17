import {
  canUseCoreDocIntel,
  parseDocumentWithCoreApi,
} from "../documentIntelligence/coreApiClient.js";
import type { NormalizedParseResult, ParseInvocationContext } from "./types.js";

export type DocumentParseProvider = "core-api";

const ACTIVE_PARSE_PROVIDER: DocumentParseProvider = "core-api";

export function getActiveParseProvider(): DocumentParseProvider {
  return ACTIVE_PARSE_PROVIDER;
}

export function canUseSharedParser(): boolean {
  if (ACTIVE_PARSE_PROVIDER === "core-api") {
    return canUseCoreDocIntel();
  }
  return false;
}

export async function parseDocumentWithSharedService(
  filePath: string,
  context?: ParseInvocationContext,
): Promise<NormalizedParseResult> {
  if (ACTIVE_PARSE_PROVIDER === "core-api") {
    return parseDocumentWithCoreApi(filePath, context);
  }

  throw new Error(`Unsupported parse provider: ${ACTIVE_PARSE_PROVIDER}`);
}
