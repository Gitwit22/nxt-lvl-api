/**
 * Text Extractor Service
 *
 * Adapter-based text extraction from uploaded files.
 * Routes files to the appropriate extractor adapter based on capabilities.
 *
 * Extraction flow:
 * 1. Detect file type
 * 2. Choose extractor adapter
 * 3. Extract text
 * 4. Normalize whitespace
 * 5. Return extraction result with metadata
 */

import type { ExtractedContent, TextExtractorAdapter } from "@/types/document";
import { plainTextExtractor } from "./extractorAdapters/plainTextExtractor";
import { pdfExtractor } from "./extractorAdapters/pdfExtractor";
import { imageOcrExtractor } from "./extractorAdapters/imageOcrExtractor";
import { fallbackExtractor } from "./extractorAdapters/fallbackExtractor";

/** Ordered list of extractor adapters. First match wins. */
const extractorAdapters: TextExtractorAdapter[] = [
  plainTextExtractor,
  pdfExtractor,
  imageOcrExtractor,
  fallbackExtractor,
];

/**
 * Normalize extracted text by cleaning whitespace and junk characters.
 */
export function normalizeExtractedText(text: string): string {
  return text
    .replace(/\r\n/g, "\n")
    .replace(/\t/g, " ")
    .replace(/[ ]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Extract structured content from a File object using the adapter pattern.
 * Returns rich metadata about the extraction including confidence and warnings.
 */
export async function extractContentFromFile(file: File): Promise<ExtractedContent> {
  for (const adapter of extractorAdapters) {
    if (adapter.canHandle(file)) {
      const result = await adapter.extract(file);
      return {
        ...result,
        text: normalizeExtractedText(result.text),
      };
    }
  }

  // Should never reach here due to fallback, but safety net
  return {
    text: `[Could not extract text from ${file.name} (${file.type})]`,
    confidence: 0,
    warnings: ["No extractor adapter found for this file type"],
  };
}

/**
 * Extract text from a File object (legacy compatibility wrapper).
 * Routes to the appropriate extractor based on MIME type.
 */
export async function extractTextFromFile(file: File): Promise<string> {
  const result = await extractContentFromFile(file);
  return result.text;
}
