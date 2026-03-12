import { useState, useMemo } from "react";
import { BookOpen, Clock, FileText, Search as SearchIcon } from "lucide-react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import SearchBar from "@/components/SearchBar";
import FilterBar from "@/components/FilterBar";
import DocumentCard from "@/components/DocumentCard";
import Timeline from "@/components/Timeline";
import { mockDocuments } from "@/data/documents";

const Index = () => {
  const [search, setSearch] = useState("");
  const [filters, setFilters] = useState({ year: "", category: "", type: "" });

  const years = useMemo(
    () => [...new Set(mockDocuments.map((d) => d.year))].sort((a, b) => b - a),
    []
  );

  const filtered = useMemo(() => {
    return mockDocuments.filter((doc) => {
      const q = search.toLowerCase();
      const matchesSearch =
        !q ||
        doc.title.toLowerCase().includes(q) ||
        doc.description.toLowerCase().includes(q) ||
        doc.keywords.some((k) => k.toLowerCase().includes(q)) ||
        doc.author.toLowerCase().includes(q);

      const matchesYear = !filters.year || doc.year === Number(filters.year);
      const matchesCategory = !filters.category || doc.category === filters.category;
      const matchesType = !filters.type || doc.type === filters.type;

      return matchesSearch && matchesYear && matchesCategory && matchesType;
    });
  }, [search, filters]);

  return (
    <div className="min-h-screen bg-background">
      {/* Header */}
      <header className="border-b border-border bg-card/60 backdrop-blur-sm sticky top-0 z-50">
        <div className="container max-w-6xl py-4 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-lg bg-primary flex items-center justify-center">
              <BookOpen className="h-5 w-5 text-primary-foreground" />
            </div>
            <div>
              <h1 className="font-display text-xl font-bold text-foreground leading-tight">
                Community Archive
              </h1>
              <p className="text-xs text-muted-foreground font-body">
                Civil Rights & Community History
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2 text-sm text-muted-foreground font-body">
            <FileText className="h-4 w-4" />
            <span>{mockDocuments.length} documents</span>
          </div>
        </div>
      </header>

      {/* Hero */}
      <section className="border-b border-border bg-gradient-to-b from-card to-background">
        <div className="container max-w-6xl py-16 text-center">
          <h2 className="font-display text-4xl md:text-5xl font-bold text-foreground mb-4 text-balance">
            Decades of Justice,
            <br />
            <span className="text-primary">Preserved & Searchable</span>
          </h2>
          <p className="text-lg text-muted-foreground font-body max-w-xl mx-auto mb-10">
            Explore reports, studies, and testimonies documenting the fight for
            racial equity and community empowerment.
          </p>
          <div className="flex justify-center">
            <SearchBar value={search} onChange={setSearch} />
          </div>
        </div>
      </section>

      {/* Main content */}
      <main className="container max-w-6xl py-10">
        <Tabs defaultValue="library" className="space-y-8">
          <TabsList className="bg-muted/60">
            <TabsTrigger value="library" className="font-body gap-2">
              <SearchIcon className="h-4 w-4" />
              Document Library
            </TabsTrigger>
            <TabsTrigger value="timeline" className="font-body gap-2">
              <Clock className="h-4 w-4" />
              Timeline
            </TabsTrigger>
          </TabsList>

          <TabsContent value="library" className="space-y-6">
            <FilterBar filters={filters} onChange={setFilters} years={years} />

            {filtered.length > 0 ? (
              <div className="space-y-4">
                <p className="text-sm text-muted-foreground font-body">
                  {filtered.length} document{filtered.length !== 1 && "s"} found
                </p>
                <div className="grid gap-4">
                  {filtered.map((doc) => (
                    <DocumentCard key={doc.id} document={doc} />
                  ))}
                </div>
              </div>
            ) : (
              <div className="text-center py-20">
                <SearchIcon className="h-12 w-12 text-muted-foreground/40 mx-auto mb-4" />
                <h3 className="font-display text-xl text-foreground mb-2">No documents found</h3>
                <p className="text-muted-foreground font-body">
                  Try adjusting your search or filters.
                </p>
              </div>
            )}
          </TabsContent>

          <TabsContent value="timeline">
            <div className="max-w-2xl">
              <h3 className="font-display text-2xl font-bold text-foreground mb-2">
                Historical Timeline
              </h3>
              <p className="text-muted-foreground font-body mb-8">
                Key milestones in the organization's history of community advocacy and research.
              </p>
              <Timeline />
            </div>
          </TabsContent>
        </Tabs>
      </main>

      {/* Footer */}
      <footer className="border-t border-border py-8">
        <div className="container max-w-6xl text-center">
          <p className="text-sm text-muted-foreground font-body">
            Community Archive — Preserving civil rights history for researchers, educators, and advocates.
          </p>
        </div>
      </footer>
    </div>
  );
};

export default Index;
