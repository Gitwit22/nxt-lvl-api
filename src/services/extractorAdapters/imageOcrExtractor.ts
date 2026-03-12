/**
 * Image OCR Extractor Adapter (Scaffold)
 *
 * SCAFFOLD: In production, integrate an OCR library such as:
 * - Tesseract.js for client-side OCR
 * - AWS Textract, Google Vision, or Azure Computer Vision for cloud OCR
 */

import type { TextExtractorAdapter, ExtractedContent } from "@/types/document";

export const imageOcrExtractor: TextExtractorAdapter = {
  canHandle(file: File): boolean {
    return file.type.startsWith("image/");
  },

  async extract(file: File): Promise<ExtractedContent> {
    // TODO: Integrate Tesseract.js or cloud OCR service
    // Example:
    // import Tesseract from 'tesseract.js';
    // const result = await Tesseract.recognize(file, 'eng');
    // return { text: result.data.text, confidence: result.data.confidence / 100 };

    return {
      text: "",
      confidence: 0,
      warnings: ["OCR not yet enabled for this file type"],
    };
  },
};
