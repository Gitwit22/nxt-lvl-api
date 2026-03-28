import { FileText, Download, Calendar, User, Tag, Sparkles, Copy, AlertTriangle } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import ProcessingStatusBadge from "@/components/ProcessingStatusBadge";
import type { ArchiveDocument } from "@/types/document";
import { MONTH_NAMES_SHORT } from "@/types/document";

interface DocumentCardProps {
  document: ArchiveDocument;
  onClick?: () => void;
}

const DocumentCard = ({ document, onClick }: DocumentCardProps) => {
  const isDuplicate = document.duplicateCheck?.duplicateStatus === "possible_duplicate";
  const needsReview = document.review?.required && !document.review?.resolution;

  return (
    <div
      className="group bg-card border border-border rounded-lg p-6 hover:shadow-lg hover:border-primary/30 transition-all duration-300 cursor-pointer"
      onClick={onClick}
    >
      <div className="flex items-start gap-4">
        <div className="flex-shrink-0 w-12 h-12 rounded-lg bg-primary/10 flex items-center justify-center">
          <FileText className="h-6 w-6 text-primary" />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-2">
            <h3 className="font-display text-lg font-semibold text-foreground leading-tight group-hover:text-primary transition-colors">
              {document.title}
            </h3>
            <ProcessingStatusBadge status={document.processingStatus} lifecycleStatus={document.status} />
          </div>
          <p className="text-sm text-muted-foreground font-body leading-relaxed mb-3 line-clamp-2">
            {document.description}
          </p>

          {/* Duplicate Warning */}
          {isDuplicate && (() => {
            const count = document.duplicateCheck?.possibleDuplicateIds?.length ?? 0;
            return (
              <div className="flex items-center gap-1.5 mb-2 px-2 py-1 bg-yellow-50 dark:bg-yellow-900/20 border border-yellow-200 dark:border-yellow-800 rounded text-xs text-yellow-700 dark:text-yellow-300 font-body">
                <Copy className="h-3 w-3" />
                Possible duplicate ({count} match{count !== 1 ? "es" : ""})
              </div>
            );
          })()}

          {/* Review Required Warning */}
          {needsReview && (
            <div className="flex items-center gap-1.5 mb-2 px-2 py-1 bg-orange-50 dark:bg-orange-900/20 border border-orange-200 dark:border-orange-800 rounded text-xs text-orange-700 dark:text-orange-300 font-body">
              <AlertTriangle className="h-3 w-3" />
              Review required{document.review?.reason ? `: ${document.review.reason[0]}` : ""}
            </div>
          )}

          {/* AI Summary Preview */}
          {document.aiSummary && (
            <div className="flex items-start gap-2 mb-3 px-3 py-2 bg-primary/5 rounded-md border border-primary/10">
              <Sparkles className="h-3.5 w-3.5 text-accent mt-0.5 flex-shrink-0" />
              <p className="text-xs text-muted-foreground font-body line-clamp-1">
                {document.aiSummary}
              </p>
            </div>
          )}

          <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-sm text-muted-foreground mb-3">
            <span className="flex items-center gap-1.5">
              <Calendar className="h-3.5 w-3.5" />
              {document.month
                ? `${MONTH_NAMES_SHORT[document.month - 1]} ${document.year}`
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
          </div>

          <div className="flex flex-wrap gap-1.5">
            <Badge variant="secondary" className="text-xs font-body font-medium">
              {document.category}
            </Badge>
            {document.financialCategory && (
              <Badge variant="secondary" className="text-xs font-body font-medium bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300">
                {document.financialCategory}
              </Badge>
            )}
            {document.financialDocumentType && (
              <Badge variant="outline" className="text-xs font-body font-medium border-blue-300 dark:border-blue-700 text-blue-600 dark:text-blue-400">
                {document.financialDocumentType}
              </Badge>
            )}
            {document.tags.slice(0, 3).map((tag) => (
              <Badge key={tag} variant="outline" className="text-xs font-body text-muted-foreground">
                {tag}
              </Badge>
            ))}
          </div>
        </div>

        <button
          className="flex-shrink-0 p-2 rounded-md text-muted-foreground hover:text-primary hover:bg-primary/10 transition-colors opacity-0 group-hover:opacity-100"
          onClick={(e) => e.stopPropagation()}
        >
          <Download className="h-5 w-5" />
        </button>
      </div>
    </div>
  );
};

export default DocumentCard;
