import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { X } from "lucide-react";
import { categories, documentTypes } from "@/data/documents";

interface Filters {
  year: string;
  category: string;
  type: string;
}

interface FilterBarProps {
  filters: Filters;
  onChange: (filters: Filters) => void;
  years: number[];
}

const FilterBar = ({ filters, onChange, years }: FilterBarProps) => {
  const hasFilters = filters.year || filters.category || filters.type;

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

      <Select value={filters.category} onValueChange={(v) => onChange({ ...filters, category: v === "all" ? "" : v })}>
        <SelectTrigger className="w-[180px] bg-card font-body">
          <SelectValue placeholder="Topic" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="all">All Topics</SelectItem>
          {categories.map((c) => (
            <SelectItem key={c} value={c}>{c}</SelectItem>
          ))}
        </SelectContent>
      </Select>

      <Select value={filters.type} onValueChange={(v) => onChange({ ...filters, type: v === "all" ? "" : v })}>
        <SelectTrigger className="w-[160px] bg-card font-body">
          <SelectValue placeholder="Type" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="all">All Types</SelectItem>
          {documentTypes.map((t) => (
            <SelectItem key={t} value={t}>{t}</SelectItem>
          ))}
        </SelectContent>
      </Select>

      {hasFilters && (
        <Button
          variant="ghost"
          size="sm"
          onClick={() => onChange({ year: "", category: "", type: "" })}
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
