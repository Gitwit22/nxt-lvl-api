import path from "node:path";
import { PDFDocument, PDFName, PDFDict, PDFRawStream, PDFRef, PDFArray } from "pdf-lib";

export type ExtractedLogoImage = {
  buffer: Buffer;
  mimeType: "image/jpeg";
  fileName: string;
};

export type PdfLogoExtractionResult = {
  images: ExtractedLogoImage[];
  warnings: string[];
};

/**
 * Minimum byte size to consider a JPEG as a real embedded logo vs a tiny thumbnail
 * (PDF viewers/editors often embed sub-KB preview thumbnails in the file structure).
 */
const MIN_LOGO_BYTES = 2048;

/**
 * Extract embedded JPEG logos from a PDF buffer.
 *
 * Strategy:
 * 1. Try pdf-lib's structured XObject walk (correct for well-formed PDFs).
 * 2. Fall back to a binary JPEG marker scan if structured parsing yields nothing
 *    or throws (e.g., encrypted or malformed PDFs).
 *
 * Only JPEG (DCTDecode) images are extracted because their raw stream bytes
 * are valid JPEG files. PNG images require FlateDecode stream decompression
 * plus image-header reconstruction — not implemented here.
 *
 * File naming: a single extracted image keeps the PDF base name (best for
 * automatic filename→company matching); multiple images get a numeric suffix.
 */
export async function extractLogosFromPdf(
  buffer: Buffer,
  pdfFileName: string,
): Promise<PdfLogoExtractionResult> {
  const baseName = path.basename(pdfFileName, path.extname(pdfFileName));

  // --- Structured extraction via pdf-lib ---
  try {
    const images = await extractViaStructured(buffer, baseName);
    if (images.length > 0) {
      return { images, warnings: [] };
    }
  } catch {
    // fall through to binary scan
  }

  // --- Binary JPEG marker scan fallback ---
  const images = extractViaBinaryScan(buffer, baseName);
  const warnings =
    images.length === 0
      ? [
          "No embedded JPEG images found in this PDF. " +
            "Ensure the PDF contains raster logo images rather than vector graphics or text.",
        ]
      : [];

  return { images, warnings };
}

// ---------------------------------------------------------------------------
// Structured extraction
// ---------------------------------------------------------------------------

async function extractViaStructured(pdfBuffer: Buffer, baseName: string): Promise<ExtractedLogoImage[]> {
  const pdfDoc = await PDFDocument.load(pdfBuffer, {
    ignoreEncryption: true,
    updateMetadata: false,
  });

  const pages = pdfDoc.getPages();
  const seenRefs = new Set<string>();
  const rawImages: Buffer[] = [];

  for (const page of pages) {
    let resources: PDFDict;
    try {
      // PDFPageLeaf.lookup() resolves inherited dicts and casts to PDFDict or throws.
      resources = page.node.lookup(PDFName.of("Resources"), PDFDict);
    } catch {
      continue;
    }

    let xObjects: PDFDict;
    try {
      xObjects = resources.lookup(PDFName.of("XObject"), PDFDict);
    } catch {
      continue;
    }

    for (const [, objOrRef] of xObjects.entries()) {
      // In well-formed PDFs XObjects are always indirect references.
      if (!(objOrRef instanceof PDFRef)) continue;

      const refKey = objOrRef.toString();
      if (seenRefs.has(refKey)) continue;
      seenRefs.add(refKey);

      let xObj: ReturnType<typeof pdfDoc.context.lookup>;
      try {
        xObj = pdfDoc.context.lookup(objOrRef);
      } catch {
        continue;
      }

      if (!(xObj instanceof PDFRawStream)) continue;

      // Must be an Image XObject.
      const subtype = xObj.dict.get(PDFName.of("Subtype"));
      if (!(subtype instanceof PDFName) || subtype.toString() !== "/Image") continue;

      // Only JPEG (DCTDecode) streams are raw JPEG bytes ready for upload.
      const filterEntry = xObj.dict.get(PDFName.of("Filter"));
      let filterName: string | undefined;
      if (filterEntry instanceof PDFName) {
        filterName = filterEntry.toString();
      } else if (filterEntry instanceof PDFArray) {
        const first = filterEntry.get(0);
        if (first instanceof PDFName) filterName = first.toString();
      }
      if (filterName !== "/DCTDecode") continue;

      const imgBuf = Buffer.from(xObj.contents);
      if (imgBuf.length < MIN_LOGO_BYTES) continue;

      rawImages.push(imgBuf);
    }
  }

  return buildNamedImages(rawImages, baseName);
}

// ---------------------------------------------------------------------------
// Binary JPEG scan
// ---------------------------------------------------------------------------

/**
 * Scan the raw PDF bytes for embedded JPEGs using SOI (FF D8 FF) / EOI (FF D9)
 * frame markers. This is safe because JPEG byte-stuffing guarantees that
 * 0xFF 0xD9 in the encoded stream is always a real EOI — it cannot appear
 * as part of entropy-coded data (raw 0xFF bytes in entropy data are escaped
 * as 0xFF 0x00 by the encoder).
 */
function extractViaBinaryScan(pdfBuffer: Buffer, baseName: string): ExtractedLogoImage[] {
  const SOI = Buffer.from([0xff, 0xd8, 0xff]);
  const EOI = Buffer.from([0xff, 0xd9]);
  const rawImages: Buffer[] = [];

  let pos = 0;
  while (pos < pdfBuffer.length) {
    const start = pdfBuffer.indexOf(SOI, pos);
    if (start === -1) break;

    const end = pdfBuffer.indexOf(EOI, start + SOI.length);
    if (end === -1) break;

    const jpeg = Buffer.from(pdfBuffer.subarray(start, end + 2));
    if (jpeg.length >= MIN_LOGO_BYTES) {
      rawImages.push(jpeg);
    }
    pos = end + 2;
  }

  return buildNamedImages(rawImages, baseName);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Name extracted images.
 * - Single image → keep the PDF's base name (`acme-corp.jpg`) so the filename
 *   normalisation matches the company name automatically.
 * - Multiple images → append a 1-based index (`acme-corp-1.jpg`, etc.).
 */
function buildNamedImages(rawImages: Buffer[], baseName: string): ExtractedLogoImage[] {
  if (rawImages.length === 0) return [];
  if (rawImages.length === 1) {
    return [{ buffer: rawImages[0], mimeType: "image/jpeg", fileName: `${baseName}.jpg` }];
  }
  return rawImages.map((buf, i) => ({
    buffer: buf,
    mimeType: "image/jpeg" as const,
    fileName: `${baseName}-${i + 1}.jpg`,
  }));
}
