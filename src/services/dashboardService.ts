/**
 * Dashboard Service
 *
 * Provides aggregation helpers for the archive operations dashboard.
 * Computes stats, breakdowns, processing health, and recent activity.
 */

import type { ArchiveDocument, DocumentLifecycleStatus, AuditTrailEvent } from "@/types/document";

/** KPI statistics for the dashboard top row */
export interface ArchiveStats {
  total: number;
  queued: number;
  extracting: number;
  reviewRequired: number;
  failed: number;
  archived: number;
  archivedToday: number;
}

/** Breakdown of documents by intake source */
export type SourceBreakdown = Record<string, number>;

/** Processing health metrics */
export interface ProcessingHealth {
  avgExtractionConfidence: number;
  failedJobs: number;
  uncategorizedCount: number;
  duplicatesFlagged: number;
  lastProcessedTime: string | null;
}

/** A recent activity event for the feed */
export interface ActivityEvent {
  documentId: string;
  documentTitle: string;
  type: string;
  timestamp: string;
  details: string;
}

/**
 * Compute archive statistics from all documents.
 */
export function getArchiveStats(documents: ArchiveDocument[]): ArchiveStats {
  const today = new Date().toISOString().slice(0, 10);
  return {
    total: documents.length,
    queued: documents.filter((d) => d.status === "queued" || d.processingStatus === "queued").length,
    extracting: documents.filter((d) => d.status === "extracting" || d.processingStatus === "processing").length,
    reviewRequired: documents.filter((d) => d.status === "review_required" || d.needsReview).length,
    failed: documents.filter((d) => d.status === "failed" || d.processingStatus === "failed").length,
    archived: documents.filter((d) => d.status === "archived" || d.processingStatus === "processed").length,
    archivedToday: documents.filter(
      (d) =>
        (d.status === "archived" || d.processingStatus === "processed") &&
        d.updatedAt.slice(0, 10) === today
    ).length,
  };
}

/**
 * Break down document counts by intake source.
 */
export function getSourceBreakdown(documents: ArchiveDocument[]): SourceBreakdown {
  const breakdown: SourceBreakdown = {};
  for (const doc of documents) {
    breakdown[doc.intakeSource] = (breakdown[doc.intakeSource] || 0) + 1;
  }
  return breakdown;
}

/**
 * Compute processing health metrics.
 */
export function getProcessingHealth(documents: ArchiveDocument[]): ProcessingHealth {
  let totalConfidence = 0;
  let confidenceCount = 0;

  for (const doc of documents) {
    if (doc.extraction?.confidence != null) {
      totalConfidence += doc.extraction.confidence;
      confidenceCount++;
    }
  }

  const processedDocs = documents
    .filter((d) => d.processingStatus === "processed" || d.processingStatus === "failed")
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));

  return {
    avgExtractionConfidence: confidenceCount > 0 ? totalConfidence / confidenceCount : 0,
    failedJobs: documents.filter((d) => d.processingStatus === "failed").length,
    uncategorizedCount: documents.filter((d) => d.category === "Uncategorized").length,
    duplicatesFlagged: documents.filter(
      (d) => d.duplicateCheck?.duplicateStatus === "possible_duplicate"
    ).length,
    lastProcessedTime: processedDocs.length > 0 ? processedDocs[0].updatedAt : null,
  };
}

/**
 * Get recent activity events from document audit trails and processing history.
 */
export function getRecentActivity(
  documents: ArchiveDocument[],
  limit = 20
): ActivityEvent[] {
  const events: ActivityEvent[] = [];

  for (const doc of documents) {
    // From audit trail
    if (doc.auditTrail) {
      for (const event of doc.auditTrail) {
        events.push({
          documentId: doc.id,
          documentTitle: doc.title,
          type: event.type,
          timestamp: event.timestamp,
          details: event.details,
        });
      }
    }

    // From processing history
    for (const event of doc.processingHistory) {
      events.push({
        documentId: doc.id,
        documentTitle: doc.title,
        type: event.action,
        timestamp: event.timestamp,
        details: event.details ?? event.action,
      });
    }
  }

  // Sort by timestamp descending and limit
  events.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
  return events.slice(0, limit);
}
