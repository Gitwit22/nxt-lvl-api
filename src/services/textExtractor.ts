/**
 * Text Extractor Service
 *
 * Extracts text content from uploaded files.
 * Currently supports plain text files directly.
 * For PDFs, Office docs, and images, this provides scaffolded hooks
 * where real extraction libraries or APIs can be plugged in.
 *
 * OCR integration point: When an OCR library (e.g., Tesseract.js) is added,
 * it plugs in at the extractTextFromImage() function.
 */

/**
 * Extract text from a File object.
 * Routes to the appropriate extractor based on MIME type.
 */
export async function extractTextFromFile(file: File): Promise<string> {
  const type = file.type;

  // Plain text files
  if (type === "text/plain" || type === "text/csv" || type === "text/markdown") {
    return extractTextFromPlainText(file);
  }

  // HTML files
  if (type === "text/html") {
    return extractTextFromHtml(file);
  }

  // PDF files
  if (type === "application/pdf") {
    return extractTextFromPdf(file);
  }

  // Image files (need OCR)
  if (type.startsWith("image/")) {
    return extractTextFromImage(file);
  }

  // Office documents
  if (
    type.includes("word") ||
    type.includes("document") ||
    type.includes("sheet") ||
    type.includes("presentation")
  ) {
    return extractTextFromOfficeDoc(file);
  }

  // Fallback: try to read as text
  try {
    return await file.text();
  } catch {
    return `[Could not extract text from ${file.name} (${type})]`;
  }
}

/** Extract text from plain text files */
async function extractTextFromPlainText(file: File): Promise<string> {
  return file.text();
}

/** Extract text from HTML files by stripping tags */
async function extractTextFromHtml(file: File): Promise<string> {
  const html = await file.text();
  const doc = new DOMParser().parseFromString(html, "text/html");
  return doc.body.textContent || "";
}

/**
 * Extract text from PDF files.
 *
 * SCAFFOLD: In production, integrate a PDF parsing library such as:
 * - pdf.js (Mozilla) for client-side extraction
 * - pdf-parse for server-side extraction
 * - A cloud API (AWS Textract, Google Document AI) for high-quality extraction
 *
 * For now, returns a placeholder indicating PDF processing is needed.
 */
async function extractTextFromPdf(file: File): Promise<string> {
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
  // return text;

  return `[PDF document: ${file.name} (${(file.size / 1024).toFixed(1)} KB) — text extraction pending. Install pdf.js for client-side extraction.]`;
}

/**
 * Extract text from images using OCR.
 *
 * SCAFFOLD: In production, integrate an OCR library such as:
 * - Tesseract.js for client-side OCR
 * - AWS Textract, Google Vision, or Azure Computer Vision for cloud OCR
 *
 * Integration point for Tesseract.js:
 * ```
 * import Tesseract from 'tesseract.js';
 * const result = await Tesseract.recognize(file, 'eng');
 * return result.data.text;
 * ```
 */
async function extractTextFromImage(file: File): Promise<string> {
  // TODO: Integrate Tesseract.js or cloud OCR service
  return `[Image document: ${file.name} (${(file.size / 1024).toFixed(1)} KB) — OCR processing pending. Install tesseract.js for client-side OCR.]`;
}

/**
 * Extract text from Office documents (Word, Excel, PowerPoint).
 *
 * SCAFFOLD: In production, integrate a document parsing library such as:
 * - mammoth.js for Word (.docx) files
 * - xlsx for Excel files
 * - A server-side LibreOffice conversion
 */
async function extractTextFromOfficeDoc(file: File): Promise<string> {
  // TODO: Integrate mammoth.js, xlsx, or server-side conversion
  return `[Office document: ${file.name} (${(file.size / 1024).toFixed(1)} KB) — text extraction pending. Install mammoth.js (Word) or xlsx (Excel) for extraction.]`;
}
