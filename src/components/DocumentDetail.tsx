import { FileText, Calendar, User, Tag, Download, Sparkles, ExternalLink } from "lucide-react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { Document } from "@/data/documents";

interface DocumentDetailProps {
  document: Document | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
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

          {/* Keywords */}
          <div>
            <h4 className="font-display text-sm font-semibold text-foreground mb-2 uppercase tracking-wider">
              Keywords
            </h4>
            <div className="flex flex-wrap gap-2">
              <Badge variant="secondary" className="text-xs font-body font-medium">
                {document.category}
              </Badge>
              {document.keywords.map((kw) => (
                <Badge key={kw} variant="outline" className="text-xs font-body text-muted-foreground">
                  {kw}
                </Badge>
              ))}
            </div>
          </div>

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
