/**
 * Llama Cloud Classification Service
 *
 * Uses @llamaindex/llama-cloud SDK to classify documents into Chronicle
 * document categories using async job polling.
 *
 * SDK pattern:
 *   client.classify.create({ file_input, configuration: { rules } }) → { id, status }
 *   client.classify.get(jobId) → { status, result: { type, confidence, reasoning } }
 */

import fs from "fs";
import LlamaCloud from "@llamaindex/llama-cloud";
import {
  LLAMA_CLOUD_API_KEY,
  ENABLE_LLAMA_CLASSIFY,
  LLAMA_CLASSIFY_AUTO_ACCEPT_THRESHOLD,
  LLAMA_CLASSIFY_REVIEW_THRESHOLD,
  LLAMA_CLASSIFY_POLL_INTERVAL_MS,
  LLAMA_CLASSIFY_MAX_POLL_ATTEMPTS,
} from "../../config/env.js";
import { logger } from "../../../logger.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ChronicleDocumentType =
  | "irs_notice"
  | "bank_receipt"
  | "invoice"
  | "meeting_minutes"
  | "board_governance"
  | "grant_document"
  | "contract"
  | "newsletter"
  | "general_report"
  | "uncategorized";

export type ChronicleClassificationStatus = "complete" | "failed" | "skipped";
export type ChronicleClassificationDecision = "auto_accepted" | "needs_review" | "low_confidence";

export interface ChronicleClassificationResult {
  provider: "llama-cloud";
  status: ChronicleClassificationStatus;
  documentType: ChronicleDocumentType;
  confidence: number | null;
  reasoning: string | null;
  jobId: string | null;
  decision: ChronicleClassificationDecision | null;
  classifiedAt: string;
  rawResult: unknown;
}

// ---------------------------------------------------------------------------
// Chronicle document category rules
// ---------------------------------------------------------------------------

const CHRONICLE_RULES: Array<{ type: string; description: string }> = [
  {
    type: "irs_notice",
    description:
      "Government tax correspondence from the IRS or U.S. Treasury, including CP notices, audit letters, " +
      "determination letters, EIN assignments, tax-exempt status letters (501c), and any document referencing " +
      "'Notice Date', 'Internal Revenue Service', 'Department of the Treasury', 'Employer Identification Number', " +
      "'EIN', or 'Tax-Exempt Organization'.",
  },
  {
    type: "bank_receipt",
    description:
      "Bank receipts, ATM receipts, deposit slips, wire transfer confirmations, bank statements, " +
      "cancelled checks, donation acknowledgments with bank reference numbers, and any document " +
      "showing a financial transaction with a bank routing or account number.",
  },
  {
    type: "invoice",
    description:
      "Bills, invoices, vendor invoices, payment requests, purchase orders, receipts for goods or " +
      "services, expense reports, reimbursement requests, and any document with a dollar amount owed " +
      "or paid to a vendor or contractor.",
  },
  {
    type: "meeting_minutes",
    description:
      "Official meeting notes, minutes, or summaries for board meetings, committee meetings, general " +
      "membership meetings, or staff meetings. Includes attendee lists, agenda items, motions, votes, " +
      "resolutions passed, and action items assigned.",
  },
  {
    type: "board_governance",
    description:
      "Organizational governance documents including bylaws, articles of incorporation, board resolutions, " +
      "conflict-of-interest policies, whistleblower policies, document retention policies, officer election " +
      "results, and other formal governance documents.",
  },
  {
    type: "grant_document",
    description:
      "Grant-related documents including grant applications, award letters, grant agreements, budget " +
      "narratives, grant reports, interim progress reports, final reports, reimbursement requests " +
      "tied to a grant, and correspondence with a foundation or government funder.",
  },
  {
    type: "contract",
    description:
      "Contracts, legal agreements, service agreements, memoranda of understanding (MOU), partnership " +
      "agreements, lease agreements, vendor contracts, independent contractor agreements, and any " +
      "document with formal terms, signatures, and obligations between parties.",
  },
  {
    type: "newsletter",
    description:
      "Newsletter-style publications, member bulletins, community updates, program announcements, " +
      "event flyers, promotional mailings, and recurring periodical communications to an audience. " +
      "Often has a masthead, volume/issue number, or dates for regular distribution.",
  },
  {
    type: "general_report",
    description:
      "Program reports, annual reports, evaluation summaries, activity logs, attendance records, " +
      "demographic data reports, impact assessments, outcome summaries, and any formal written " +
      "report that does not fit the other specific categories above.",
  },
  {
    type: "uncategorized",
    description:
      "Documents that do not clearly fit any of the other categories, including scanned items with " +
      "unclear content, forms without sufficient context, or miscellaneous correspondence that cannot " +
      "be confidently assigned to another type.",
  },
];

// ---------------------------------------------------------------------------
// MIME types that Llama Cloud classify can accept
// ---------------------------------------------------------------------------

const CLASSIFY_SUPPORTED_MIME_TYPES = new Set([
  "application/pdf",
  "image/jpeg",
  "image/jpg",
  "image/png",
  "image/gif",
  "image/tiff",
  "image/webp",
  "text/plain",
]);

// ---------------------------------------------------------------------------
// Singleton client
// ---------------------------------------------------------------------------

let cachedClient: LlamaCloud | null = null;

function getClient(): LlamaCloud {
  if (!LLAMA_CLOUD_API_KEY) {
    throw new Error("LLAMA_CLOUD_API_KEY is not configured");
  }
  if (!cachedClient) {
    cachedClient = new LlamaCloud({ apiKey: LLAMA_CLOUD_API_KEY });
  }
  return cachedClient;
}

// ---------------------------------------------------------------------------
// Sleep helper for polling
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Classify a document file with Llama Cloud
// ---------------------------------------------------------------------------

export async function classifyDocumentWithLlamaCloud(
  filePath: string,
  mimeType: string | null,
  context?: { documentId?: string; jobId?: string },
): Promise<ChronicleClassificationResult> {
  const classifiedAt = new Date().toISOString();

  // Skip if feature is disabled
  if (!ENABLE_LLAMA_CLASSIFY) {
    return {
      provider: "llama-cloud",
      status: "skipped",
      documentType: "uncategorized",
      confidence: null,
      reasoning: "Llama Cloud classification is disabled via ENABLE_LLAMA_CLASSIFY=false",
      jobId: null,
      decision: null,
      classifiedAt,
      rawResult: null,
    };
  }

  // Skip unsupported MIME types
  if (!mimeType || !CLASSIFY_SUPPORTED_MIME_TYPES.has(mimeType)) {
    logger.info("Skipping Llama classify — unsupported MIME type for classification", {
      documentId: context?.documentId,
      jobId: context?.jobId,
      mimeType,
    });
    return {
      provider: "llama-cloud",
      status: "skipped",
      documentType: "uncategorized",
      confidence: null,
      reasoning: `MIME type '${mimeType ?? "unknown"}' is not supported for Llama Cloud classification`,
      jobId: null,
      decision: null,
      classifiedAt,
      rawResult: null,
    };
  }

  let client: LlamaCloud;
  try {
    client = getClient();
  } catch (err) {
    logger.warn("Llama classify skipped — no API key", {
      documentId: context?.documentId,
      jobId: context?.jobId,
    });
    return {
      provider: "llama-cloud",
      status: "skipped",
      documentType: "uncategorized",
      confidence: null,
      reasoning: "LLAMA_CLOUD_API_KEY not configured",
      jobId: null,
      decision: null,
      classifiedAt,
      rawResult: null,
    };
  }

  // Upload the file first
  let fileId: string;
  const fileStream = fs.createReadStream(filePath);
  try {
    logger.info("Llama classify — uploading file", {
      documentId: context?.documentId,
      jobId: context?.jobId,
      mimeType,
    });

    const fileObj = await client.files.create({
      file: fileStream,
      purpose: "parse",
    });
    fileId = fileObj.id;
  } catch (err) {
    fileStream.destroy();
    logger.error("Llama classify — file upload failed", {
      documentId: context?.documentId,
      jobId: context?.jobId,
      error: err instanceof Error ? err.message : String(err),
    });
    return {
      provider: "llama-cloud",
      status: "failed",
      documentType: "uncategorized",
      confidence: null,
      reasoning: "File upload to Llama Cloud failed",
      jobId: null,
      decision: null,
      classifiedAt,
      rawResult: { error: err instanceof Error ? err.message : String(err) },
    };
  } finally {
    fileStream.destroy();
  }

  // Create classify job
  let classifyJobId: string;
  try {
    logger.info("Llama classify — creating classify job", {
      documentId: context?.documentId,
      jobId: context?.jobId,
      fileId,
    });

    const createResponse = await client.classify.create({
      file_input: fileId,
      configuration: {
        rules: CHRONICLE_RULES,
      },
    });

    classifyJobId = createResponse.id;
  } catch (err) {
    logger.error("Llama classify — job creation failed", {
      documentId: context?.documentId,
      jobId: context?.jobId,
      fileId,
      error: err instanceof Error ? err.message : String(err),
    });
    return {
      provider: "llama-cloud",
      status: "failed",
      documentType: "uncategorized",
      confidence: null,
      reasoning: "Failed to create classify job",
      jobId: null,
      decision: null,
      classifiedAt,
      rawResult: { error: err instanceof Error ? err.message : String(err) },
    };
  }

  // Poll for completion
  let attempts = 0;
  while (attempts < LLAMA_CLASSIFY_MAX_POLL_ATTEMPTS) {
    await sleep(LLAMA_CLASSIFY_POLL_INTERVAL_MS);
    attempts++;

    let pollResponse: Awaited<ReturnType<typeof client.classify.get>>;
    try {
      pollResponse = await client.classify.get(classifyJobId);
    } catch (err) {
      logger.warn("Llama classify — poll attempt failed", {
        documentId: context?.documentId,
        jobId: context?.jobId,
        classifyJobId,
        attempt: attempts,
        error: err instanceof Error ? err.message : String(err),
      });
      // Retry polling — don't fail after a single poll error
      continue;
    }

    const jobStatus = pollResponse.status;

    if (jobStatus === "COMPLETED") {
      const result = pollResponse.result;
      if (!result) {
        logger.warn("Llama classify — COMPLETED with no result", {
          documentId: context?.documentId,
          classifyJobId,
        });
        return {
          provider: "llama-cloud",
          status: "failed",
          documentType: "uncategorized",
          confidence: null,
          reasoning: "Classification job completed but returned no result",
          jobId: classifyJobId,
          decision: null,
          classifiedAt,
          rawResult: pollResponse,
        };
      }

      const rawType = result.type ?? "uncategorized";
      const documentType = isValidChronicleType(rawType) ? rawType : "uncategorized";
      const confidence = result.confidence ?? 0;
      const reasoning = result.reasoning ?? null;

      // Apply confidence thresholds to make a decision
      let decision: ChronicleClassificationDecision;
      if (confidence >= LLAMA_CLASSIFY_AUTO_ACCEPT_THRESHOLD) {
        decision = "auto_accepted";
      } else if (confidence >= LLAMA_CLASSIFY_REVIEW_THRESHOLD) {
        decision = "needs_review";
      } else {
        decision = "low_confidence";
      }

      logger.info("Llama classify — classification complete", {
        documentId: context?.documentId,
        classifyJobId,
        documentType,
        confidence,
        decision,
        attempts,
      });

      return {
        provider: "llama-cloud",
        status: "complete",
        documentType,
        confidence,
        reasoning,
        jobId: classifyJobId,
        decision,
        classifiedAt,
        rawResult: pollResponse,
      };
    }

    if (jobStatus === "FAILED") {
      logger.error("Llama classify — job failed", {
        documentId: context?.documentId,
        classifyJobId,
        attempts,
        rawStatus: pollResponse,
      });
      return {
        provider: "llama-cloud",
        status: "failed",
        documentType: "uncategorized",
        confidence: null,
        reasoning: "Llama Cloud classification job failed",
        jobId: classifyJobId,
        decision: null,
        classifiedAt,
        rawResult: pollResponse,
      };
    }

    // PENDING or RUNNING — keep polling
    logger.info("Llama classify — polling", {
      documentId: context?.documentId,
      classifyJobId,
      attempt: attempts,
      status: jobStatus,
    });
  }

  // Max poll attempts exceeded
  logger.warn("Llama classify — polling timed out", {
    documentId: context?.documentId,
    classifyJobId,
    maxAttempts: LLAMA_CLASSIFY_MAX_POLL_ATTEMPTS,
  });

  return {
    provider: "llama-cloud",
    status: "failed",
    documentType: "uncategorized",
    confidence: null,
    reasoning: `Classification timed out after ${LLAMA_CLASSIFY_MAX_POLL_ATTEMPTS} poll attempts`,
    jobId: classifyJobId,
    decision: null,
    classifiedAt,
    rawResult: null,
  };
}

// ---------------------------------------------------------------------------
// Type guard
// ---------------------------------------------------------------------------

const VALID_CHRONICLE_TYPES = new Set<string>([
  "irs_notice",
  "bank_receipt",
  "invoice",
  "meeting_minutes",
  "board_governance",
  "grant_document",
  "contract",
  "newsletter",
  "general_report",
  "uncategorized",
]);

function isValidChronicleType(value: string): value is ChronicleDocumentType {
  return VALID_CHRONICLE_TYPES.has(value);
}
