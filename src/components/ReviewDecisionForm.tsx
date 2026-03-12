/**
 * Review Decision Form
 *
 * Form for resolving a document review with a decision,
 * notes, and optional metadata corrections.
 */

import { useState } from "react";
import { CheckCircle2, XCircle, RefreshCw, Copy, Edit } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import type { ArchiveDocument, ReviewMetadata } from "@/types/document";

interface ReviewDecisionFormProps {
  document: ArchiveDocument;
  onResolve: (docId: string, resolution: ReviewMetadata["resolution"], notes: string) => void;
  onCancel?: () => void;
}

const resolutionOptions: Array<{
  value: ReviewMetadata["resolution"];
  label: string;
  icon: React.ElementType;
  description: string;
  variant: "default" | "outline" | "destructive";
}> = [
  {
    value: "approved",
    label: "Approve",
    icon: CheckCircle2,
    description: "Document is correct as-is",
    variant: "default",
  },
  {
    value: "corrected",
    label: "Corrected",
    icon: Edit,
    description: "Metadata has been manually fixed",
    variant: "outline",
  },
  {
    value: "reprocessed",
    label: "Reprocess",
    icon: RefreshCw,
    description: "Re-run extraction and categorization",
    variant: "outline",
  },
  {
    value: "duplicate",
    label: "Duplicate",
    icon: Copy,
    description: "Confirmed as duplicate",
    variant: "outline",
  },
  {
    value: "rejected",
    label: "Reject",
    icon: XCircle,
    description: "Remove from archive",
    variant: "destructive",
  },
];

const ReviewDecisionForm = ({ document, onResolve, onCancel }: ReviewDecisionFormProps) => {
  const [selectedResolution, setSelectedResolution] = useState<ReviewMetadata["resolution"]>();
  const [notes, setNotes] = useState("");

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2 mb-2">
        <h4 className="font-display text-sm font-semibold text-foreground uppercase tracking-wider">
          Review: {document.title}
        </h4>
      </div>

      {/* Review reasons */}
      {document.review?.reason && document.review.reason.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {document.review.reason.map((r, i) => (
            <Badge key={i} variant="outline" className="text-xs text-orange-600 border-orange-300">
              {r}
            </Badge>
          ))}
        </div>
      )}

      {/* Resolution options */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
        {resolutionOptions.map((opt) => {
          const Icon = opt.icon;
          const isSelected = selectedResolution === opt.value;
          return (
            <button
              key={opt.value}
              className={`flex items-start gap-3 p-3 rounded-lg border text-left transition-colors ${
                isSelected
                  ? "border-primary bg-primary/5"
                  : "border-border hover:border-primary/30 hover:bg-muted/50"
              }`}
              onClick={() => setSelectedResolution(opt.value)}
            >
              <Icon className={`h-4 w-4 mt-0.5 ${isSelected ? "text-primary" : "text-muted-foreground"}`} />
              <div>
                <div className="font-body text-sm font-medium text-foreground">{opt.label}</div>
                <div className="font-body text-xs text-muted-foreground">{opt.description}</div>
              </div>
            </button>
          );
        })}
      </div>

      {/* Notes */}
      <div>
        <label className="font-body text-sm font-medium text-foreground block mb-1">
          Notes (optional)
        </label>
        <textarea
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          placeholder="Add any notes about this decision..."
          className="w-full h-20 px-3 py-2 text-sm font-body rounded-md border border-border bg-background focus:outline-none focus:ring-2 focus:ring-primary/50 resize-none"
        />
      </div>

      {/* Actions */}
      <div className="flex gap-2 justify-end">
        {onCancel && (
          <Button variant="ghost" size="sm" onClick={onCancel} className="font-body">
            Cancel
          </Button>
        )}
        <Button
          size="sm"
          disabled={!selectedResolution}
          onClick={() => {
            if (selectedResolution) {
              onResolve(document.id, selectedResolution, notes);
            }
          }}
          className="font-body"
        >
          Submit Decision
        </Button>
      </div>
    </div>
  );
};

export default ReviewDecisionForm;
