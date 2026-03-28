import { useState, useMemo } from "react";
import { Clock, FileText, Search as SearchIcon, Shield, Database, Upload, Globe, PenLine, LayoutDashboard, Eye } from "lucide-react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import SearchBar from "@/components/SearchBar";
import FilterBar from "@/components/FilterBar";
import DocumentCard from "@/components/DocumentCard";
import DocumentDetail from "@/components/DocumentDetail";
import UploadDialog from "@/components/UploadDialog";
import ManualEntryForm from "@/components/ManualEntryForm";
import Timeline from "@/components/Timeline";
import ArchiveDashboard from "@/components/ArchiveDashboard";
import ReviewQueuePanel from "@/components/ReviewQueuePanel";
import { useDocuments, useDocumentYears, useResolveReview } from "@/hooks/useDocuments";
import { searchDocuments } from "@/services/documentStore";
import { resolveReview } from "@/services/reviewQueueService";
import { retryProcessing } from "@/services/processingPipeline";
import type { ArchiveDocument } from "@/types/document";

const Index = () => {
  const [search, setSearch] = useState("");
  const [filters, setFilters] = useState({ year: "", month: "", category: "", type: "", financialCategory: "", financialDocumentType: "", intakeSource: "", processingStatus: "" });
  const [selectedDoc, setSelectedDoc] = useState<ArchiveDocument | null>(null);
  const [uploadOpen, setUploadOpen] = useState(false);
  const [manualEntryOpen, setManualEntryOpen] = useState(false);

  const { data: allDocuments = [], isLoading } = useDocuments();
  const { data: years = [] } = useDocumentYears();
  const resolveReviewMutation = useResolveReview();

  const filtered = useMemo(() => {
    return searchDocuments({
      search: search || undefined,
      year: filters.year || undefined,
      month: filters.month || undefined,
      category: filters.category || undefined,
      type: filters.type || undefined,
      financialCategory: filters.financialCategory || undefined,
      financialDocumentType: filters.financialDocumentType || undefined,
      intakeSource: filters.intakeSource || undefined,
      processingStatus: filters.processingStatus || undefined,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search, filters, allDocuments.length]);

  const handleDashboardFilter = (status: string) => {
    setFilters({ year: "", month: "", category: "", type: "", financialCategory: "", financialDocumentType: "", intakeSource: "", processingStatus: status });
  };

  const handleReviewResolve = (docId: string, resolution: string) => {
    if (resolution === "reprocessed") {
      retryProcessing(docId);
    } else {
      resolveReview(docId, resolution as any, undefined);
    }
    resolveReviewMutation.mutate({ docId, resolution: resolution as any });
  };

  return (
    <div className="min-h-screen bg-background">
      {/* Header */}
      <header className="border-b border-border bg-card/60 backdrop-blur-sm sticky top-0 z-50">
        <div className="container max-w-6xl py-4 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-lg bg-primary flex items-center justify-center">
              <Shield className="h-5 w-5 text-primary-foreground" />
            </div>
            <div>
              <h1 className="font-display text-xl font-bold text-foreground leading-tight">
                Equity Research Vault
              </h1>
              <p className="text-xs text-muted-foreground font-body">
                Civil Rights Document Archive
              </p>
            </div>
          </div>
          <div className="flex items-center gap-4">
            <div className="flex items-center gap-2 text-sm text-muted-foreground font-body">
              <FileText className="h-4 w-4" />
              <span>{allDocuments.length} documents</span>
            </div>
            <Button
              onClick={() => setUploadOpen(true)}
              className="gap-2 font-body bg-primary hover:bg-primary/90"
              size="sm"
            >
              <Upload className="h-4 w-4" />
              Upload
            </Button>
            <Button
              onClick={() => setManualEntryOpen(true)}
              variant="outline"
              className="gap-2 font-body"
              size="sm"
            >
              <PenLine className="h-4 w-4" />
              New Entry
            </Button>
          </div>
        </div>
      </header>

      {/* Hero */}
      <section className="border-b border-border bg-gradient-to-b from-primary/5 to-background">
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
          <div className="flex justify-center mb-12">
            <SearchBar value={search} onChange={setSearch} />
          </div>

          {/* System capabilities */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4 max-w-3xl mx-auto">
            {[
              { icon: Globe, label: "Public Library", desc: "Open research access" },
              { icon: Database, label: "Digital Archive", desc: "Structured metadata" },
              { icon: Upload, label: "Document System", desc: "Upload & organize" },
              { icon: SearchIcon, label: "Smart Search", desc: "AI-powered discovery" },
            ].map(({ icon: Icon, label, desc }) => (
              <div key={label} className="flex flex-col items-center gap-2 p-4 rounded-xl bg-card border border-border">
                <div className="w-10 h-10 rounded-lg bg-accent/10 flex items-center justify-center">
                  <Icon className="h-5 w-5 text-accent" />
                </div>
                <span className="font-body text-sm font-semibold text-foreground">{label}</span>
                <span className="font-body text-xs text-muted-foreground">{desc}</span>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Main content */}
      <main className="container max-w-6xl py-10">
        <Tabs defaultValue="library" className="space-y-8">
          <TabsList className="bg-muted/60">
            <TabsTrigger value="dashboard" className="font-body gap-2">
              <LayoutDashboard className="h-4 w-4" />
              Dashboard
            </TabsTrigger>
            <TabsTrigger value="library" className="font-body gap-2">
              <SearchIcon className="h-4 w-4" />
              Document Library
            </TabsTrigger>
            <TabsTrigger value="review" className="font-body gap-2">
              <Eye className="h-4 w-4" />
              Review Queue
            </TabsTrigger>
            <TabsTrigger value="timeline" className="font-body gap-2">
              <Clock className="h-4 w-4" />
              Timeline
            </TabsTrigger>
          </TabsList>

          <TabsContent value="dashboard" className="space-y-6">
            <ArchiveDashboard
              documents={allDocuments}
              onFilterByStatus={handleDashboardFilter}
            />
          </TabsContent>

          <TabsContent value="library" className="space-y-6">
            <FilterBar filters={filters} onChange={setFilters} years={years} />

            {isLoading ? (
              <div className="text-center py-20">
                <div className="h-12 w-12 mx-auto mb-4 border-4 border-primary/30 border-t-primary rounded-full animate-spin" />
                <p className="text-muted-foreground font-body">Loading documents...</p>
              </div>
            ) : filtered.length > 0 ? (
              <div className="space-y-4">
                <p className="text-sm text-muted-foreground font-body">
                  {filtered.length} document{filtered.length !== 1 && "s"} found
                </p>
                <div className="grid gap-4">
                  {filtered.map((doc) => (
                    <DocumentCard
                      key={doc.id}
                      document={doc}
                      onClick={() => setSelectedDoc(doc)}
                    />
                  ))}
                </div>
              </div>
            ) : (
              <div className="text-center py-20">
                <SearchIcon className="h-12 w-12 text-muted-foreground/40 mx-auto mb-4" />
                <h3 className="font-display text-xl text-foreground mb-2">No documents found</h3>
                <p className="text-muted-foreground font-body mb-6">
                  Try adjusting your search or filters, or add new documents.
                </p>
                <div className="flex justify-center gap-3">
                  <Button
                    onClick={() => setUploadOpen(true)}
                    className="gap-2 font-body"
                  >
                    <Upload className="h-4 w-4" />
                    Upload Documents
                  </Button>
                  <Button
                    onClick={() => setManualEntryOpen(true)}
                    variant="outline"
                    className="gap-2 font-body"
                  >
                    <PenLine className="h-4 w-4" />
                    Manual Entry
                  </Button>
                </div>
              </div>
            )}
          </TabsContent>

          <TabsContent value="review" className="space-y-6">
            <ReviewQueuePanel
              documents={allDocuments}
              onSelectDocument={setSelectedDoc}
              onResolve={handleReviewResolve}
            />
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
            Equity Research Vault — Preserving civil rights history for researchers, educators, and advocates.
          </p>
        </div>
      </footer>

      {/* Dialogs */}
      <DocumentDetail
        document={selectedDoc}
        open={!!selectedDoc}
        onOpenChange={(open) => !open && setSelectedDoc(null)}
      />
      <UploadDialog open={uploadOpen} onOpenChange={setUploadOpen} />
      <ManualEntryForm open={manualEntryOpen} onOpenChange={setManualEntryOpen} />
    </div>
  );
};

export default Index;
