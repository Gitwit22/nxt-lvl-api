/**
 * Archive Dashboard
 *
 * Operations dashboard showing KPI cards, source breakdown,
 * processing health, recent activity, and review queue summary.
 */

import {
  FileText,
  Clock,
  AlertCircle,
  CheckCircle2,
  Eye,
  Upload,
  Loader2,
  Archive,
  Activity,
  BarChart3,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import type { ArchiveDocument } from "@/types/document";
import {
  getArchiveStats,
  getSourceBreakdown,
  getProcessingHealth,
  getRecentActivity,
} from "@/services/dashboardService";

interface ArchiveDashboardProps {
  documents: ArchiveDocument[];
  onFilterByStatus?: (status: string) => void;
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

const ArchiveDashboard = ({ documents, onFilterByStatus }: ArchiveDashboardProps) => {
  const stats = getArchiveStats(documents);
  const sources = getSourceBreakdown(documents);
  const health = getProcessingHealth(documents);
  const recentActivity = getRecentActivity(documents, 10);

  const kpiCards = [
    { label: "Total Documents", value: stats.total, icon: FileText, color: "text-primary", filterStatus: "" },
    { label: "Queued", value: stats.queued, icon: Clock, color: "text-yellow-600", filterStatus: "queued" },
    { label: "Extracting", value: stats.extracting, icon: Loader2, color: "text-indigo-600", filterStatus: "processing" },
    { label: "Review Required", value: stats.reviewRequired, icon: Eye, color: "text-orange-600", filterStatus: "needs_review" },
    { label: "Failed", value: stats.failed, icon: AlertCircle, color: "text-red-600", filterStatus: "failed" },
    { label: "Archived", value: stats.archived, icon: Archive, color: "text-green-600", filterStatus: "processed" },
  ];

  return (
    <div className="space-y-6">
      {/* KPI Cards */}
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
        {kpiCards.map((kpi) => {
          const Icon = kpi.icon;
          return (
            <button
              key={kpi.label}
              className="bg-card border border-border rounded-lg p-4 text-left hover:shadow-md hover:border-primary/30 transition-all"
              onClick={() => onFilterByStatus?.(kpi.filterStatus)}
            >
              <div className="flex items-center gap-2 mb-2">
                <Icon className={`h-4 w-4 ${kpi.color}`} />
                <span className="font-body text-xs text-muted-foreground">{kpi.label}</span>
              </div>
              <div className="font-display text-2xl font-bold text-foreground">
                {kpi.value}
              </div>
            </button>
          );
        })}
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
        {/* Intake Sources */}
        <div className="bg-card border border-border rounded-lg p-5">
          <div className="flex items-center gap-2 mb-4">
            <Upload className="h-4 w-4 text-primary" />
            <h4 className="font-display text-sm font-semibold text-foreground uppercase tracking-wider">
              Intake Sources
            </h4>
          </div>
          <div className="space-y-2">
            {Object.entries(sources)
              .sort(([, a], [, b]) => b - a)
              .map(([source, count]) => (
                <div key={source} className="flex items-center justify-between text-sm font-body">
                  <span className="text-muted-foreground">
                    {INTAKE_SOURCE_LABELS[source] || source}
                  </span>
                  <Badge variant="secondary" className="text-xs">{count}</Badge>
                </div>
              ))}
          </div>
        </div>

        {/* Processing Health */}
        <div className="bg-card border border-border rounded-lg p-5">
          <div className="flex items-center gap-2 mb-4">
            <BarChart3 className="h-4 w-4 text-primary" />
            <h4 className="font-display text-sm font-semibold text-foreground uppercase tracking-wider">
              Processing Health
            </h4>
          </div>
          <div className="space-y-3 text-sm font-body">
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground">Avg Confidence</span>
              <span className={`font-medium ${health.avgExtractionConfidence >= 0.7 ? "text-green-600" : health.avgExtractionConfidence >= 0.4 ? "text-yellow-600" : "text-muted-foreground"}`}>
                {health.avgExtractionConfidence > 0
                  ? `${(health.avgExtractionConfidence * 100).toFixed(0)}%`
                  : "N/A"}
              </span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground">Failed Jobs</span>
              <span className={`font-medium ${health.failedJobs > 0 ? "text-red-600" : "text-green-600"}`}>
                {health.failedJobs}
              </span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground">Uncategorized</span>
              <span className="font-medium text-foreground">{health.uncategorizedCount}</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground">Duplicates Flagged</span>
              <span className={`font-medium ${health.duplicatesFlagged > 0 ? "text-yellow-600" : "text-foreground"}`}>
                {health.duplicatesFlagged}
              </span>
            </div>
            {health.lastProcessedTime && (
              <div className="flex items-center justify-between">
                <span className="text-muted-foreground">Last Processed</span>
                <span className="text-foreground/60 text-xs">
                  {new Date(health.lastProcessedTime).toLocaleString()}
                </span>
              </div>
            )}
          </div>
        </div>

        {/* Recent Activity */}
        <div className="bg-card border border-border rounded-lg p-5">
          <div className="flex items-center gap-2 mb-4">
            <Activity className="h-4 w-4 text-primary" />
            <h4 className="font-display text-sm font-semibold text-foreground uppercase tracking-wider">
              Recent Activity
            </h4>
          </div>
          <div className="space-y-2 max-h-60 overflow-y-auto">
            {recentActivity.length === 0 ? (
              <p className="text-sm text-muted-foreground font-body">No recent activity.</p>
            ) : (
              recentActivity.map((event, i) => (
                <div key={i} className="flex items-start gap-2 text-xs font-body">
                  <CheckCircle2 className="h-3 w-3 text-muted-foreground mt-0.5 flex-shrink-0" />
                  <div className="min-w-0">
                    <span className="text-foreground font-medium truncate block">
                      {event.documentTitle}
                    </span>
                    <span className="text-muted-foreground">
                      {event.type} — {new Date(event.timestamp).toLocaleString()}
                    </span>
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
      </div>
    </div>
  );
};

export default ArchiveDashboard;
