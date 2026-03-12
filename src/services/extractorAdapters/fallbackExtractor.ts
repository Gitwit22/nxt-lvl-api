/**
 * Fallback Extractor Adapter
 *
 * Handles any file type not covered by other adapters.
 * Attempts to read as text; returns a placeholder if that fails.
 */

import type { TextExtractorAdapter, ExtractedContent } from "@/types/document";

export const fallbackExtractor: TextExtractorAdapter = {
  canHandle(): boolean {
    return true;
  },

  async extract(file: File): Promise<ExtractedContent> {
    // Office documents scaffold
    if (
      file.type.includes("word") ||
      file.type.includes("document") ||
      file.type.includes("sheet") ||
      file.type.includes("presentation")
    ) {
      return {
        text: `[Office document: ${file.name} (${(file.size / 1024).toFixed(1)} KB) — text extraction pending. Install mammoth.js (Word) or xlsx (Excel) for extraction.]`,
        confidence: 0,
        warnings: ["Office document extraction not yet enabled."],
      };
    }

    // Try reading as raw text
    try {
      const text = await file.text();
      return {
        text,
        confidence: 0.5,
        warnings: ["Extracted using fallback text reader. Results may be unreliable."],
      };
    } catch {
      return {
        text: `[Could not extract text from ${file.name} (${file.type})]`,
        confidence: 0,
        warnings: [`Failed to extract text from ${file.name}`],
      };
    }
  },
};
