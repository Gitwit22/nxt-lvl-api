import fs from "fs";
import LlamaCloud from "@llamaindex/llama-cloud";
import { LLAMA_CLOUD_API_KEY } from "../../config/env.js";
import { logger } from "../../../logger.js";
import type { NormalizedParseResult, ParseInvocationContext } from "./types.js";

let cachedClient: LlamaCloud | null = null;

function getClient(): LlamaCloud {
  if (!LLAMA_CLOUD_API_KEY) {
    throw new Error("LLAMA_CLOUD_API_KEY is not configured");
  }

  if (!cachedClient) {
    cachedClient = new LlamaCloud({
      apiKey: LLAMA_CLOUD_API_KEY,
    });
  }

  return cachedClient;
}

function extractOptionalArray(value: unknown): unknown[] | undefined {
  return Array.isArray(value) ? value : undefined;
}

export function isLlamaCloudConfigured(): boolean {
  return Boolean(LLAMA_CLOUD_API_KEY);
}

export async function parseDocumentWithLlamaCloud(
  filePath: string,
  context?: ParseInvocationContext,
): Promise<NormalizedParseResult> {
  const client = getClient();

  logger.info("Llama Cloud parse started", {
    provider: "llama-cloud",
    documentId: context?.documentId,
    jobId: context?.jobId,
    mimeType: context?.mimeType,
    filePath,
  });

  const fileStream = fs.createReadStream(filePath);

  try {
    const fileObj = await client.files.create({
      file: fileStream,
      purpose: "parse",
    });

    logger.info("Llama Cloud file uploaded", {
      provider: "llama-cloud",
      documentId: context?.documentId,
      jobId: context?.jobId,
      fileId: fileObj.id,
    });

    const result = await client.parsing.parse({
      file_id: fileObj.id,
      tier: "agentic",
      version: "latest",
      expand: ["markdown_full"],
    });

    const markdown =
      result && typeof result === "object" && "markdown_full" in result && typeof (result as { markdown_full?: unknown }).markdown_full === "string"
        ? ((result as { markdown_full?: string }).markdown_full ?? "")
        : "";

    const normalized: NormalizedParseResult = {
      provider: "llama-cloud",
      text: markdown,
      markdown,
      pages:
        result && typeof result === "object" && "pages" in result
          ? extractOptionalArray((result as { pages?: unknown }).pages)
          : undefined,
      tables:
        result && typeof result === "object" && "tables" in result
          ? extractOptionalArray((result as { tables?: unknown }).tables)
          : undefined,
      entities:
        result && typeof result === "object" && "entities" in result
          ? extractOptionalArray((result as { entities?: unknown }).entities)
          : undefined,
      rawResult: result,
    };

    logger.info("Llama Cloud parse completed", {
      provider: "llama-cloud",
      documentId: context?.documentId,
      jobId: context?.jobId,
      hasMarkdown: normalized.markdown.length > 0,
      textLength: normalized.text.length,
    });

    return normalized;
  } catch (error) {
    logger.error("Llama Cloud parse failed", {
      provider: "llama-cloud",
      documentId: context?.documentId,
      jobId: context?.jobId,
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  } finally {
    fileStream.destroy();
  }
}
