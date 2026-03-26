/**
 * PDF Extractor Adapter (Scaffold)
 *
 * SCAFFOLD: In production, integrate a PDF parsing library such as:
 * - pdf.js (Mozilla) for client-side extraction
 * - pdf-parse for server-side extraction
 * - A cloud API (AWS Textract, Google Document AI) for high-quality extraction
 */

import type { TextExtractorAdapter, ExtractedContent } from "@/types/document";

export const pdfExtractor: TextExtractorAdapter = {
  canHandle(file: File): boolean {
    return file.type === "application/pdf";
  },

  async extract(file: File): Promise<ExtractedContent> {
    // TODO: Integrate pdf.js or server-side PDF extraction
    // Example integration point:
    // const pdfJs = await import('pdfjs-dist');
    // const pdf = await pdfJs.getDocument(await file.arrayBuffer()).promise;
    // let text = '';
    // for (let i = 1; i <= pdf.numPages; i++) {
    //   const page = await pdf.getPage(i);
    //   const content = await page.getTextContent();
    //   text += content.items.map(item => item.str).join(' ') + '\n';
    // }
    // return { text, pages: pdf.numPages, confidence: 0.85 };

    return {
      text: `[PDF document: ${file.name} (${(file.size / 1024).toFixed(1)} KB) — text extraction pending. Install pdf.js for client-side extraction.]`,
      confidence: 0,
      warnings: ["PDF text extraction not yet enabled. Install pdf.js for client-side extraction."],
    };
  },
};
