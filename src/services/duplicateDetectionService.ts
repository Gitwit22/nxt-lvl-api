/**
 * Duplicate Detection Service
 *
 * Detects exact and near-duplicate documents to prevent
 * archive quality degradation as volume grows.
 *
 * Strategies:
 * 1. SHA-256 hash for exact content duplicates
 * 2. Normalized filename fingerprinting
 * 3. Heuristic scoring for near-duplicates
 */

import type { ArchiveDocument, DuplicateCheckMetadata } from "@/types/document";
import { getAllDocuments, updateDocument } from "./documentStore";

/** Compute SHA-256 hash of a file's contents */
export async function hashFile(file: File): Promise<string> {
  const buffer = await file.arrayBuffer();
  const hashBuffer = await crypto.subtle.digest("SHA-256", buffer);
  return Array.from(new Uint8Array(hashBuffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** Normalize a filename for comparison */
export function normalizeFilename(name: string): string {
  return name.toLowerCase().replace(/\.[^.]+$/, "").replace(/[^a-z0-9]/g, "");
}

/** Check if two extracted text prefixes are similar */
function similarTextPrefix(textA: string, textB: string, prefixLength = 200): boolean {
  if (!textA || !textB) return false;
  const a = textA.slice(0, prefixLength).toLowerCase().trim();
  const b = textB.slice(0, prefixLength).toLowerCase().trim();
  if (a.length < 20 || b.length < 20) return false;
  return a === b;
}

/** Duplicate scoring thresholds */
const DUPLICATE_THRESHOLD = 50;

/**
 * Score a candidate document against a target for duplicate likelihood.
 * Returns a score from 0–175 (higher = more likely duplicate).
 */
export function scoreDuplicate(
  target: ArchiveDocument,
  candidate: ArchiveDocument
): number {
  let score = 0;

  // Exact hash match
  if (
    target.duplicateCheck?.hash &&
    candidate.duplicateCheck?.hash &&
    target.duplicateCheck.hash === candidate.duplicateCheck.hash
  ) {
    score += 100;
  }

  // Same normalized filename
  if (target.originalFileName && candidate.originalFileName) {
    if (normalizeFilename(target.originalFileName) === normalizeFilename(candidate.originalFileName)) {
      score += 25;
    }
  }

  // Similar extracted text prefix
  if (similarTextPrefix(target.extractedText, candidate.extractedText)) {
    score += 25;
  }

  // Same file size
  if (target.fileSize && candidate.fileSize && target.fileSize === candidate.fileSize) {
    score += 15;
  }

  // Same intake source
  if (target.intakeSource === candidate.intakeSource) {
    score += 10;
  }

  return score;
}

/**
 * Check a document for duplicates against the existing archive.
 * Returns updated duplicate check metadata.
 */
export function checkForDuplicates(
  doc: ArchiveDocument
): DuplicateCheckMetadata {
  const allDocs = getAllDocuments();
  const possibleDuplicateIds: string[] = [];

  for (const candidate of allDocs) {
    if (candidate.id === doc.id) continue;

    const score = scoreDuplicate(doc, candidate);
    if (score >= DUPLICATE_THRESHOLD) {
      possibleDuplicateIds.push(candidate.id);
    }
  }

  const filenameFingerprint = doc.originalFileName
    ? normalizeFilename(doc.originalFileName)
    : undefined;

  return {
    hash: doc.duplicateCheck?.hash,
    filenameFingerprint,
    possibleDuplicateIds,
    duplicateStatus: possibleDuplicateIds.length > 0 ? "possible_duplicate" : "unique",
    checkedAt: new Date().toISOString(),
  };
}

/**
 * Run duplicate detection on a document and persist results.
 * Optionally hashes the file for exact-match detection.
 */
export async function detectDuplicates(
  docId: string,
  file?: File
): Promise<DuplicateCheckMetadata | undefined> {
  const allDocs = getAllDocuments();
  const doc = allDocs.find((d) => d.id === docId);
  if (!doc) return undefined;

  // Compute hash if file is provided
  if (file) {
    try {
      const hash = await hashFile(file);
      doc.duplicateCheck = { ...doc.duplicateCheck, hash };
    } catch {
      // Hash computation failed, continue without hash
    }
  }

  const result = checkForDuplicates(doc);
  updateDocument(docId, { duplicateCheck: result });

  // If flagged, also set review
  if (result.duplicateStatus === "possible_duplicate") {
    updateDocument(docId, {
      review: {
        required: true,
        reason: [...(doc.review?.reason ?? []), "Possible duplicate detected"],
        priority: "medium",
      },
    });
  }

  return result;
}

/**
 * Mark a document's duplicate status manually.
 */
export function resolveDuplicateStatus(
  docId: string,
  status: "unique" | "confirmed_duplicate"
): void {
  updateDocument(docId, {
    duplicateCheck: {
      duplicateStatus: status,
      checkedAt: new Date().toISOString(),
    },
  });
}
