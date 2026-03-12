import { FileText, Calendar, User, Tag, Download, Sparkles, ExternalLink, Clock, Info } from "lucide-react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import ProcessingStatusBadge from "@/components/ProcessingStatusBadge";
import type { ArchiveDocument } from "@/types/document";

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
                  {document.year}
                </span>
                <span className="flex items-center gap-1.5">
                  <User className="h-3.5 w-3.5" />
                  {document.author}
                </span>
                <span className="flex items-center gap-1.5">
                  <Tag className="h-3.5 w-3.5" />
                  {document.type}
                </span>
                <ProcessingStatusBadge status={document.processingStatus} />
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
