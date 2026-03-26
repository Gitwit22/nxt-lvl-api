/**
 * Review Queue Panel
 *
 * Displays documents that need human review, sorted by priority.
 * Shows reason, confidence, status, and quick actions.
 */

import { Eye, AlertTriangle, CheckCircle2, RefreshCw, Copy, XCircle } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import ProcessingStatusBadge from "@/components/ProcessingStatusBadge";
import type { ArchiveDocument } from "@/types/document";

interface ReviewQueuePanelProps {
  documents: ArchiveDocument[];
  onSelectDocument?: (doc: ArchiveDocument) => void;
  onResolve?: (docId: string, resolution: string) => void;
}

const priorityColors: Record<string, string> = {
  high: "bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-200",
  medium: "bg-yellow-100 text-yellow-800 dark:bg-yellow-900 dark:text-yellow-200",
  low: "bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200",
};

const ReviewQueuePanel = ({ documents, onSelectDocument, onResolve }: ReviewQueuePanelProps) => {
  const reviewDocs = documents.filter(
    (doc) => doc.review?.required && !doc.review?.resolution
  );

  const priorityOrder: Record<string, number> = { high: 0, medium: 1, low: 2 };
  const sorted = [...reviewDocs].sort((a, b) => {
    const pa = priorityOrder[a.review?.priority ?? "low"] ?? 2;
    const pb = priorityOrder[b.review?.priority ?? "low"] ?? 2;
    return pa - pb;
  });

  if (sorted.length === 0) {
    return (
      <div className="text-center py-12">
        <CheckCircle2 className="h-12 w-12 text-green-400 mx-auto mb-4" />
        <h3 className="font-display text-lg text-foreground mb-1">Review Queue Empty</h3>
        <p className="text-sm text-muted-foreground font-body">
          All documents have been reviewed or are processing normally.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2">
          <Eye className="h-5 w-5 text-primary" />
          <h3 className="font-display text-lg font-semibold text-foreground">
            Review Queue
          </h3>
          <Badge variant="secondary" className="text-xs">{sorted.length}</Badge>
        </div>
      </div>

      {sorted.map((doc) => (
        <div
          key={doc.id}
          className="bg-card border border-border rounded-lg p-4 hover:shadow-md transition-shadow cursor-pointer"
          onClick={() => onSelectDocument?.(doc)}
        >
          <div className="flex items-start justify-between gap-3">
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 mb-1">
                <h4 className="font-display text-sm font-semibold text-foreground truncate">
                  {doc.title}
                </h4>
                <ProcessingStatusBadge status={doc.processingStatus} lifecycleStatus={doc.status} />
                {doc.review?.priority && (
                  <Badge className={`text-xs ${priorityColors[doc.review.priority] || ""}`}>
                    {doc.review.priority}
                  </Badge>
                )}
              </div>

              {doc.review?.reason && doc.review.reason.length > 0 && (
                <div className="flex flex-wrap gap-1 mb-2">
                  {doc.review.reason.map((r, i) => (
                    <span key={i} className="inline-flex items-center gap-1 text-xs text-orange-600 dark:text-orange-400 font-body">
                      <AlertTriangle className="h-3 w-3" />
                      {r}
                    </span>
                  ))}
                </div>
              )}

              <div className="flex items-center gap-3 text-xs text-muted-foreground font-body">
                <span>{doc.category}</span>
                {doc.extraction?.confidence != null && (
                  <span>Confidence: {(doc.extraction.confidence * 100).toFixed(0)}%</span>
                )}
                {doc.duplicateCheck?.duplicateStatus === "possible_duplicate" && (
                  <span className="flex items-center gap-1 text-yellow-600">
                    <Copy className="h-3 w-3" />
                    Possible duplicate
                  </span>
                )}
                <span>{doc.intakeSource.replace(/_/g, " ")}</span>
              </div>
            </div>

            <div className="flex items-center gap-1 flex-shrink-0">
              <Button
                variant="ghost"
                size="sm"
                className="h-7 px-2 text-xs"
                onClick={(e) => {
                  e.stopPropagation();
                  onResolve?.(doc.id, "approved");
                }}
              >
                <CheckCircle2 className="h-3 w-3 mr-1" />
                Approve
              </Button>
              <Button
                variant="ghost"
                size="sm"
                className="h-7 px-2 text-xs"
                onClick={(e) => {
                  e.stopPropagation();
                  onResolve?.(doc.id, "reprocessed");
                }}
              >
                <RefreshCw className="h-3 w-3 mr-1" />
                Retry
              </Button>
              <Button
                variant="ghost"
                size="sm"
                className="h-7 px-2 text-xs text-destructive"
                onClick={(e) => {
                  e.stopPropagation();
                  onResolve?.(doc.id, "rejected");
                }}
              >
                <XCircle className="h-3 w-3 mr-1" />
                Reject
              </Button>
            </div>
          </div>
        </div>
      ))}
    </div>
  );
};

export default ReviewQueuePanel;
