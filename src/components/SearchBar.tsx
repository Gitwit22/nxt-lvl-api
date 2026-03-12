import { Search } from "lucide-react";
import { Input } from "@/components/ui/input";

interface SearchBarProps {
  value: string;
  onChange: (value: string) => void;
}

const SearchBar = ({ value, onChange }: SearchBarProps) => {
  return (
    <div className="relative w-full max-w-2xl">
      <Search className="absolute left-4 top-1/2 -translate-y-1/2 h-5 w-5 text-muted-foreground" />
      <Input
        placeholder="Search documents by title, keyword, or content..."
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="pl-12 h-13 text-base bg-card border-border rounded-lg font-body placeholder:text-muted-foreground focus-visible:ring-primary"
      />
    </div>
  );
};

export default SearchBar;
