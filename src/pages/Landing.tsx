import { Link } from "react-router-dom";
import { Shield, Globe, Database, Upload, Search, BookOpen, Users, FileText } from "lucide-react";
import { Button } from "@/components/ui/button";
import { PROGRAM_DISPLAY_NAME } from "@/lib/programInfo";

const features = [
  {
    icon: Globe,
    title: "Public Research Library",
    description:
      "Open access to decades of civil rights documentation, studies, and testimonies.",
  },
  {
    icon: Database,
    title: "Structured Digital Archive",
    description:
      "Every document is categorized with rich metadata — year, type, financial classification, and more.",
  },
  {
    icon: Upload,
    title: "Document Intake System",
    description:
      "Upload files or enter records manually. The system extracts text, detects duplicates, and routes documents for review.",
  },
  {
    icon: Search,
    title: "Smart Full-Text Search",
    description:
      "Find any document instantly across titles, extracted text, tags, authors, and keywords.",
  },
  {
    icon: BookOpen,
    title: "Historical Timeline",
    description:
      "Explore key milestones in community advocacy and equity research across the decades.",
  },
  {
    icon: Users,
    title: "Role-Based Access",
    description:
      "Uploaders, reviewers, and administrators each have the right level of access to keep the archive accurate and trustworthy.",
  },
];

export default function Landing() {
  return (
    <div className="min-h-screen bg-background flex flex-col">
      {/* Nav */}
      <header className="border-b border-border bg-card/60 backdrop-blur-sm sticky top-0 z-50">
        <div className="container max-w-6xl py-4 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-lg bg-primary flex items-center justify-center">
              <Shield className="h-5 w-5 text-primary-foreground" />
            </div>
            <div>
              <h1 className="font-display text-xl font-bold text-foreground leading-tight">
                {PROGRAM_DISPLAY_NAME}
              </h1>
              <p className="text-xs text-muted-foreground font-body">
                Civil Rights Document Archive
              </p>
            </div>
          </div>
          <Link to="/login">
            <Button className="font-body bg-primary hover:bg-primary/90">Sign In</Button>
          </Link>
        </div>
      </header>

      {/* Hero */}
      <section className="border-b border-border bg-gradient-to-b from-primary/5 to-background">
        <div className="container max-w-5xl py-24 text-center">
          <div className="inline-flex items-center gap-2 px-4 py-1.5 rounded-full bg-primary/10 text-primary text-sm font-body font-medium mb-8">
            <FileText className="h-4 w-4" />
            {PROGRAM_DISPLAY_NAME} — Document Archive
          </div>
          <h2 className="font-display text-4xl md:text-6xl font-bold text-foreground mb-6 text-balance leading-tight">
            Decades of Justice,
            <br />
            <span className="text-primary">Preserved &amp; Searchable</span>
          </h2>
          <p className="text-lg md:text-xl text-muted-foreground font-body max-w-2xl mx-auto mb-10 leading-relaxed">
            A secure, structured archive for civil rights research, community advocacy
            records, and equity documentation — built for researchers, educators, and
            advocates who need reliable access to history.
          </p>
          <div className="flex flex-col sm:flex-row items-center justify-center gap-4">
            <Link to="/login">
              <Button size="lg" className="font-body px-8 bg-primary hover:bg-primary/90">
                Sign In to the Archive
              </Button>
            </Link>
            <a
              href="#features"
              className="text-sm font-body text-muted-foreground hover:text-foreground transition-colors underline underline-offset-4"
            >
              Learn what's inside
            </a>
          </div>
        </div>
      </section>

      {/* Features */}
      <section id="features" className="py-20 border-b border-border">
        <div className="container max-w-6xl">
          <div className="text-center mb-14">
            <h3 className="font-display text-3xl font-bold text-foreground mb-3">
              Everything you need to preserve history
            </h3>
            <p className="text-muted-foreground font-body max-w-xl mx-auto">
              From intake to retrieval, every step of the document lifecycle is tracked,
              searchable, and auditable.
            </p>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-6">
            {features.map(({ icon: Icon, title, description }) => (
              <div
                key={title}
                className="p-6 rounded-xl bg-card border border-border hover:border-primary/30 transition-colors"
              >
                <div className="w-11 h-11 rounded-lg bg-primary/10 flex items-center justify-center mb-4">
                  <Icon className="h-5 w-5 text-primary" />
                </div>
                <h4 className="font-display text-lg font-semibold text-foreground mb-2">
                  {title}
                </h4>
                <p className="text-sm text-muted-foreground font-body leading-relaxed">
                  {description}
                </p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* CTA */}
      <section className="py-20 bg-primary/5">
        <div className="container max-w-3xl text-center">
          <h3 className="font-display text-3xl font-bold text-foreground mb-4">
            Ready to access the archive?
          </h3>
          <p className="text-muted-foreground font-body mb-8">
            Sign in with your account credentials to upload documents, review the queue,
            and explore the full archive.
          </p>
          <Link to="/login">
            <Button size="lg" className="font-body px-10 bg-primary hover:bg-primary/90">
              Sign In
            </Button>
          </Link>
        </div>
      </section>

      {/* Footer */}
      <footer className="border-t border-border py-8 mt-auto">
        <div className="container max-w-6xl text-center">
          <p className="text-sm text-muted-foreground font-body">
            {PROGRAM_DISPLAY_NAME} — Preserving civil rights history for researchers,
            educators, and advocates.
          </p>
        </div>
      </footer>
    </div>
  );
}
