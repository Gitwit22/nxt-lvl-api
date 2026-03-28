import { FileText, Calendar, User, Tag, Download, Sparkles, ExternalLink, Clock, Info, AlertTriangle, Shield, Copy } from "lucide-react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import ProcessingStatusBadge from "@/components/ProcessingStatusBadge";
import type { ArchiveDocument } from "@/types/document";
import { MONTH_NAMES } from "@/types/document";

interface DocumentDetailProps {
  document: ArchiveDocument | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/** Format an intake source for display */
function formatIntakeSource(source: string): string {
  return source
    .replace(/_/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

const DocumentDetail = ({ document, open, onOpenChange }: DocumentDetailProps) => {
  if (!document) return null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <div className="flex items-start gap-4">
            <div className="flex-shrink-0 w-14 h-14 rounded-xl bg-primary/10 flex items-center justify-center">
              <FileText className="h-7 w-7 text-primary" />
            </div>
            <div>
              <DialogTitle className="font-display text-xl font-bold text-foreground leading-tight">
                {document.title}
              </DialogTitle>
              <div className="flex flex-wrap items-center gap-3 mt-2 text-sm text-muted-foreground">
                <span className="flex items-center gap-1.5">
                  <Calendar className="h-3.5 w-3.5" />
                  {document.month
                    ? `${MONTH_NAMES[document.month - 1]} ${document.year}`
                    : document.year}
                </span>
                <span className="flex items-center gap-1.5">
                  <User className="h-3.5 w-3.5" />
                  {document.author}
                </span>
                <span className="flex items-center gap-1.5">
                  <Tag className="h-3.5 w-3.5" />
                  {document.type}
                </span>
                <ProcessingStatusBadge status={document.processingStatus} lifecycleStatus={document.status} />
              </div>
            </div>
          </div>
        </DialogHeader>

        <div className="space-y-6 mt-4">
          {/* Description */}
          <div>
            <h4 className="font-display text-sm font-semibold text-foreground mb-2 uppercase tracking-wider">
              Description
            </h4>
            <p className="text-muted-foreground font-body leading-relaxed">
              {document.description}
            </p>
          </div>

          {/* Financial Classification */}
          {(document.financialCategory || document.financialDocumentType) && (
            <div className="bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800 rounded-lg p-4">
              <h4 className="font-display text-sm font-semibold text-blue-800 dark:text-blue-200 mb-2 uppercase tracking-wider">
                Financial Classification
              </h4>
              <div className="flex flex-wrap gap-2">
                {document.financialCategory && (
                  <Badge variant="secondary" className="bg-blue-100 dark:bg-blue-900/40 text-blue-700 dark:text-blue-300">
                    {document.financialCategory}
                  </Badge>
                )}
                {document.financialDocumentType && (
                  <Badge variant="outline" className="border-blue-300 dark:border-blue-700 text-blue-600 dark:text-blue-400">
                    {document.financialDocumentType}
                  </Badge>
                )}
              </div>
            </div>
          )}

          {/* AI Summary */}
          {document.aiSummary && (
            <div className="bg-primary/5 border border-primary/20 rounded-xl p-5">
              <div className="flex items-center gap-2 mb-3">
                <Sparkles className="h-4 w-4 text-accent" />
                <h4 className="font-display text-sm font-semibold text-accent uppercase tracking-wider">
                  AI Summary
                </h4>
              </div>
              <p className="text-foreground font-body leading-relaxed text-sm">
                {document.aiSummary}
              </p>
            </div>
          )}

          {/* Extraction Status */}
          {document.extraction && (
            <div className="bg-muted/30 border border-border rounded-lg p-4">
              <div className="flex items-center gap-2 mb-3">
                <Shield className="h-4 w-4 text-muted-foreground" />
                <h4 className="font-display text-sm font-semibold text-foreground uppercase tracking-wider">
                  Extraction Details
                </h4>
              </div>
              <div className="grid grid-cols-2 gap-2 text-sm font-body">
                <div className="text-muted-foreground">
                  Status: <span className="text-foreground font-medium">{document.extraction.status}</span>
                </div>
                {document.extraction.method && (
                  <div className="text-muted-foreground">
                    Method: <span className="text-foreground font-medium">{document.extraction.method}</span>
                  </div>
                )}
                {document.extraction.confidence != null && (
                  <div className="text-muted-foreground">
                    Confidence: <span className={`font-medium ${document.extraction.confidence >= 0.7 ? "text-green-600" : document.extraction.confidence >= 0.4 ? "text-yellow-600" : "text-red-600"}`}>
                      {(document.extraction.confidence * 100).toFixed(0)}%
                    </span>
                  </div>
                )}
                {document.extraction.pageCount != null && (
                  <div className="text-muted-foreground">
                    Pages: <span className="text-foreground font-medium">{document.extraction.pageCount}</span>
                  </div>
                )}
                {document.extraction.extractedAt && (
                  <div className="text-muted-foreground col-span-2">
                    Extracted: <span className="text-foreground/60">{new Date(document.extraction.extractedAt).toLocaleString()}</span>
                  </div>
                )}
              </div>
              {document.extraction.warningMessages && document.extraction.warningMessages.length > 0 && (
                <div className="mt-2 space-y-1">
                  {document.extraction.warningMessages.map((w, i) => (
                    <div key={i} className="flex items-center gap-1.5 text-xs text-yellow-600">
                      <AlertTriangle className="h-3 w-3" />
                      {w}
                    </div>
                  ))}
                </div>
              )}
              {document.extraction.errorMessage && (
                <div className="mt-2 flex items-center gap-1.5 text-xs text-red-600">
                  <AlertTriangle className="h-3 w-3" />
                  {document.extraction.errorMessage}
                </div>
              )}
            </div>
          )}

          {/* Duplicate Check */}
          {document.duplicateCheck && document.duplicateCheck.duplicateStatus !== "unique" && (
            <div className="bg-yellow-50 dark:bg-yellow-900/20 border border-yellow-200 dark:border-yellow-800 rounded-lg p-4">
              <div className="flex items-center gap-2 mb-2">
                <Copy className="h-4 w-4 text-yellow-600" />
                <h4 className="font-display text-sm font-semibold text-yellow-800 dark:text-yellow-200 uppercase tracking-wider">
                  Possible Duplicate
                </h4>
              </div>
              <p className="text-sm text-yellow-700 dark:text-yellow-300 font-body">
                This document may be a duplicate of {document.duplicateCheck.possibleDuplicateIds?.length ?? 0} other document(s).
              </p>
            </div>
          )}

          {/* Review Status */}
          {document.review?.required && !document.review?.resolution && (
            <div className="bg-orange-50 dark:bg-orange-900/20 border border-orange-200 dark:border-orange-800 rounded-lg p-4">
              <div className="flex items-center gap-2 mb-2">
                <AlertTriangle className="h-4 w-4 text-orange-600" />
                <h4 className="font-display text-sm font-semibold text-orange-800 dark:text-orange-200 uppercase tracking-wider">
                  Review Required
                </h4>
                {document.review.priority && (
                  <Badge variant="outline" className="text-xs">
                    {document.review.priority}
                  </Badge>
                )}
              </div>
              {document.review.reason && document.review.reason.length > 0 && (
                <ul className="text-sm text-orange-700 dark:text-orange-300 font-body list-disc pl-4 space-y-0.5">
                  {document.review.reason.map((r, i) => (
                    <li key={i}>{r}</li>
                  ))}
                </ul>
              )}
            </div>
          )}
          {document.review?.resolution && (
            <div className="bg-green-50 dark:bg-green-900/20 border border-green-200 dark:border-green-800 rounded-lg p-4">
              <div className="flex items-center gap-2 mb-1">
                <Shield className="h-4 w-4 text-green-600" />
                <span className="font-display text-sm font-semibold text-green-800 dark:text-green-200 uppercase tracking-wider">
                  Reviewed
                </span>
                <Badge variant="outline" className="text-xs">{document.review.resolution}</Badge>
              </div>
              {document.review.notes && (
                <p className="text-sm text-green-700 dark:text-green-300 font-body mt-1">{document.review.notes}</p>
              )}
            </div>
          )}

          {/* Extracted Text Preview */}
          {document.extractedText && document.extractedText.length > 0 && (
            <div>
              <h4 className="font-display text-sm font-semibold text-foreground mb-2 uppercase tracking-wider">
                Extracted Text
              </h4>
              <div className="bg-muted/50 border border-border rounded-lg p-4 max-h-40 overflow-y-auto">
                <p className="text-sm text-muted-foreground font-body whitespace-pre-wrap">
                  {document.extractedText.slice(0, 1000)}
                  {document.extractedText.length > 1000 && "..."}
                </p>
              </div>
            </div>
          )}

          {/* Keywords & Tags */}
          <div>
            <h4 className="font-display text-sm font-semibold text-foreground mb-2 uppercase tracking-wider">
              Tags & Keywords
            </h4>
            <div className="flex flex-wrap gap-2">
              <Badge variant="secondary" className="text-xs font-body font-medium">
                {document.category}
              </Badge>
              {document.tags.map((tag) => (
                <Badge key={tag} variant="outline" className="text-xs font-body text-muted-foreground">
                  {tag}
                </Badge>
              ))}
            </div>
          </div>

          {/* Document Metadata */}
          <div>
            <h4 className="font-display text-sm font-semibold text-foreground mb-2 uppercase tracking-wider">
              Metadata
            </h4>
            <div className="grid grid-cols-2 gap-2 text-sm font-body">
              <div className="flex items-center gap-2 text-muted-foreground">
                <Info className="h-3.5 w-3.5" />
                Source: {formatIntakeSource(document.intakeSource)}
              </div>
              {document.originalFileName && (
                <div className="flex items-center gap-2 text-muted-foreground">
                  <FileText className="h-3.5 w-3.5" />
                  {document.originalFileName}
                </div>
              )}
              {document.fileSize && (
                <div className="flex items-center gap-2 text-muted-foreground">
                  <Info className="h-3.5 w-3.5" />
                  {(document.fileSize / 1024).toFixed(1)} KB
                </div>
              )}
              {document.department && (
                <div className="flex items-center gap-2 text-muted-foreground">
                  <Info className="h-3.5 w-3.5" />
                  Dept: {document.department}
                </div>
              )}
              {document.extractedMetadata?.wordCount && (
                <div className="flex items-center gap-2 text-muted-foreground">
                  <Info className="h-3.5 w-3.5" />
                  {document.extractedMetadata.wordCount} words
                </div>
              )}
              {document.ocrStatus !== "not_needed" && (
                <div className="flex items-center gap-2 text-muted-foreground">
                  <Info className="h-3.5 w-3.5" />
                  OCR: {document.ocrStatus}
                </div>
              )}
            </div>
          </div>

          {/* Processing History */}
          {document.processingHistory.length > 0 && (
            <div>
              <h4 className="font-display text-sm font-semibold text-foreground mb-2 uppercase tracking-wider">
                Processing History
              </h4>
              <div className="space-y-1 max-h-32 overflow-y-auto">
                {document.processingHistory.map((event, i) => (
                  <div
                    key={i}
                    className="flex items-center gap-2 text-xs text-muted-foreground font-body"
                  >
                    <Clock className="h-3 w-3 flex-shrink-0" />
                    <span className="text-foreground/60">
                      {new Date(event.timestamp).toLocaleString()}
                    </span>
                    <span>{event.details || event.action}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Actions */}
          <div className="flex gap-3 pt-2">
            <Button className="gap-2 font-body bg-primary hover:bg-primary/90">
              <Download className="h-4 w-4" />
              Download Document
            </Button>
            <Button variant="outline" className="gap-2 font-body">
              <ExternalLink className="h-4 w-4" />
              Open Original
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
};

export default DocumentDetail;
