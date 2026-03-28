import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { X } from "lucide-react";
import { DOCUMENT_CATEGORIES, DOCUMENT_TYPES, FINANCIAL_CATEGORIES, FINANCIAL_DOCUMENT_TYPES, MONTH_NAMES } from "@/types/document";

interface Filters {
  year: string;
  month: string;
  category: string;
  type: string;
  financialCategory: string;
  financialDocumentType: string;
  intakeSource: string;
  processingStatus: string;
}

interface FilterBarProps {
  filters: Filters;
  onChange: (filters: Filters) => void;
  years: number[];
}

const INTAKE_SOURCE_LABELS: Record<string, string> = {
  file_upload: "File Upload",
  multi_upload: "Multi Upload",
  drag_drop: "Drag & Drop",
  bulk_folder: "Folder Upload",
  scanner_import: "Scanner",
  email_import: "Email",
  cloud_import: "Cloud",
  manual_entry: "Manual Entry",
  legacy_import: "Legacy Import",
};

const PROCESSING_STATUS_LABELS: Record<string, string> = {
  uploaded: "Uploaded",
  imported: "Imported",
  queued: "Queued",
  processing: "Processing",
  processed: "Processed",
  failed: "Failed",
  needs_review: "Needs Review",
};

const LIFECYCLE_STATUS_LABELS: Record<string, string> = {
  intake_received: "Received",
  queued: "Queued",
  extracting: "Extracting",
  extracted: "Extracted",
  categorized: "Categorized",
  review_required: "Review Required",
  archived: "Archived",
  failed: "Failed",
};

const FilterBar = ({ filters, onChange, years }: FilterBarProps) => {
  const hasFilters =
    filters.year || filters.month || filters.category || filters.type ||
    filters.financialCategory || filters.financialDocumentType ||
    filters.intakeSource || filters.processingStatus;

  return (
    <div className="flex flex-wrap items-center gap-3">
      <Select value={filters.year} onValueChange={(v) => onChange({ ...filters, year: v === "all" ? "" : v })}>
        <SelectTrigger className="w-[140px] bg-card font-body">
          <SelectValue placeholder="Year" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="all">All Years</SelectItem>
          {years.map((y) => (
            <SelectItem key={y} value={String(y)}>{y}</SelectItem>
          ))}
        </SelectContent>
      </Select>

      <Select value={filters.month} onValueChange={(v) => onChange({ ...filters, month: v === "all" ? "" : v })}>
        <SelectTrigger className="w-[150px] bg-card font-body">
          <SelectValue placeholder="Month" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="all">All Months</SelectItem>
          {MONTH_NAMES.map((name, i) => (
            <SelectItem key={i + 1} value={String(i + 1)}>{name}</SelectItem>
          ))}
        </SelectContent>
      </Select>

      <Select value={filters.financialCategory} onValueChange={(v) => onChange({ ...filters, financialCategory: v === "all" ? "" : v })}>
        <SelectTrigger className="w-[160px] bg-card font-body">
          <SelectValue placeholder="Funding/Spending" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="all">All Financial</SelectItem>
          {FINANCIAL_CATEGORIES.map((c) => (
            <SelectItem key={c} value={c}>{c}</SelectItem>
          ))}
        </SelectContent>
      </Select>

      <Select value={filters.financialDocumentType} onValueChange={(v) => onChange({ ...filters, financialDocumentType: v === "all" ? "" : v })}>
        <SelectTrigger className="w-[180px] bg-card font-body">
          <SelectValue placeholder="Doc Type" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="all">All Doc Types</SelectItem>
          {FINANCIAL_DOCUMENT_TYPES.map((t) => (
            <SelectItem key={t} value={t}>{t}</SelectItem>
          ))}
        </SelectContent>
      </Select>

      <Select value={filters.category} onValueChange={(v) => onChange({ ...filters, category: v === "all" ? "" : v })}>
        <SelectTrigger className="w-[180px] bg-card font-body">
          <SelectValue placeholder="Topic" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="all">All Topics</SelectItem>
          {DOCUMENT_CATEGORIES.map((c) => (
            <SelectItem key={c} value={c}>{c}</SelectItem>
          ))}
        </SelectContent>
      </Select>

      <Select value={filters.type} onValueChange={(v) => onChange({ ...filters, type: v === "all" ? "" : v })}>
        <SelectTrigger className="w-[160px] bg-card font-body">
          <SelectValue placeholder="Format" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="all">All Formats</SelectItem>
          {DOCUMENT_TYPES.map((t) => (
            <SelectItem key={t} value={t}>{t}</SelectItem>
          ))}
        </SelectContent>
      </Select>

      <Select
        value={filters.intakeSource}
        onValueChange={(v) => onChange({ ...filters, intakeSource: v === "all" ? "" : v })}
      >
        <SelectTrigger className="w-[160px] bg-card font-body">
          <SelectValue placeholder="Source" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="all">All Sources</SelectItem>
          {Object.entries(INTAKE_SOURCE_LABELS).map(([value, label]) => (
            <SelectItem key={value} value={value}>
              {label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      <Select
        value={filters.processingStatus}
        onValueChange={(v) => onChange({ ...filters, processingStatus: v === "all" ? "" : v })}
      >
        <SelectTrigger className="w-[160px] bg-card font-body">
          <SelectValue placeholder="Status" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="all">All Statuses</SelectItem>
          {Object.entries(PROCESSING_STATUS_LABELS).map(([value, label]) => (
            <SelectItem key={value} value={value}>
              {label}
            </SelectItem>
          ))}
          <SelectItem value="_separator" disabled>──────────</SelectItem>
          {Object.entries(LIFECYCLE_STATUS_LABELS).map(([value, label]) => (
            <SelectItem key={`lc-${value}`} value={`lifecycle:${value}`}>
              ⏵ {label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      {hasFilters && (
        <Button
          variant="ghost"
          size="sm"
          onClick={() => onChange({ year: "", month: "", category: "", type: "", financialCategory: "", financialDocumentType: "", intakeSource: "", processingStatus: "" })}
          className="text-muted-foreground hover:text-foreground font-body"
        >
          <X className="h-4 w-4 mr-1" />
          Clear
        </Button>
      )}
    </div>
  );
};

export default FilterBar;
