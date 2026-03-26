/**
 * Plain Text Extractor Adapter
 *
 * Handles text/plain, text/csv, text/markdown, and text/html files.
 */

import type { TextExtractorAdapter, ExtractedContent } from "@/types/document";

const PLAIN_TEXT_TYPES = ["text/plain", "text/csv", "text/markdown"];

export const plainTextExtractor: TextExtractorAdapter = {
  canHandle(file: File): boolean {
    return PLAIN_TEXT_TYPES.includes(file.type) || file.type === "text/html";
  },

  async extract(file: File): Promise<ExtractedContent> {
    if (file.type === "text/html") {
      const html = await file.text();
      const doc = new DOMParser().parseFromString(html, "text/html");
      const text = doc.body.textContent || "";
      return {
        text,
        confidence: 0.95,
        language: "en",
      };
    }

    const text = await file.text();
    return {
      text,
      confidence: 1.0,
      language: "en",
    };
  },
};
