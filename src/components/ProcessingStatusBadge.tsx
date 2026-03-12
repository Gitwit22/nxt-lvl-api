/**
 * Processing Status Badge Component
 *
 * Displays the processing status of a document with appropriate
 * colors and icons for each status. Supports both legacy ProcessingStatus
 * and new DocumentLifecycleStatus.
 */

import { Badge } from "@/components/ui/badge";
import {
  CheckCircle2,
  Clock,
  Loader2,
  AlertCircle,
  Eye,
  Upload,
  ArrowDownToLine,
  Archive,
  FileSearch,
  FolderCheck,
  Inbox,
} from "lucide-react";
import type { ProcessingStatus, DocumentLifecycleStatus } from "@/types/document";

interface ProcessingStatusBadgeProps {
  status: ProcessingStatus;
  lifecycleStatus?: DocumentLifecycleStatus;
  className?: string;
}

const statusConfig: Record<
  ProcessingStatus,
  { label: string; variant: "default" | "secondary" | "destructive" | "outline"; icon: React.ElementType }
> = {
  uploaded: {
    label: "Uploaded",
    variant: "secondary",
    icon: Upload,
  },
  imported: {
    label: "Imported",
    variant: "secondary",
    icon: ArrowDownToLine,
  },
  queued: {
    label: "Queued",
    variant: "outline",
    icon: Clock,
  },
  processing: {
    label: "Processing",
    variant: "default",
    icon: Loader2,
  },
  processed: {
    label: "Processed",
    variant: "default",
    icon: CheckCircle2,
  },
  failed: {
    label: "Failed",
    variant: "destructive",
    icon: AlertCircle,
  },
  needs_review: {
    label: "Needs Review",
    variant: "outline",
    icon: Eye,
  },
};

const lifecycleConfig: Record<
  DocumentLifecycleStatus,
  { label: string; variant: "default" | "secondary" | "destructive" | "outline"; icon: React.ElementType; colorClass: string }
> = {
  intake_received: {
    label: "Received",
    variant: "secondary",
    icon: Inbox,
    colorClass: "bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200",
  },
  queued: {
    label: "Queued",
    variant: "outline",
    icon: Clock,
    colorClass: "bg-yellow-100 text-yellow-800 dark:bg-yellow-900 dark:text-yellow-200",
  },
  extracting: {
    label: "Extracting",
    variant: "default",
    icon: FileSearch,
    colorClass: "bg-indigo-100 text-indigo-800 dark:bg-indigo-900 dark:text-indigo-200",
  },
  extracted: {
    label: "Extracted",
    variant: "default",
    icon: FolderCheck,
    colorClass: "bg-cyan-100 text-cyan-800 dark:bg-cyan-900 dark:text-cyan-200",
  },
  categorized: {
    label: "Categorized",
    variant: "default",
    icon: CheckCircle2,
    colorClass: "bg-teal-100 text-teal-800 dark:bg-teal-900 dark:text-teal-200",
  },
  review_required: {
    label: "Review Required",
    variant: "outline",
    icon: Eye,
    colorClass: "bg-orange-100 text-orange-800 dark:bg-orange-900 dark:text-orange-200",
  },
  archived: {
    label: "Archived",
    variant: "default",
    icon: Archive,
    colorClass: "bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200",
  },
  failed: {
    label: "Failed",
    variant: "destructive",
    icon: AlertCircle,
    colorClass: "bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-200",
  },
};

const ProcessingStatusBadge = ({ status, lifecycleStatus, className }: ProcessingStatusBadgeProps) => {
  // Prefer lifecycle status if available
  if (lifecycleStatus) {
    const lc = lifecycleConfig[lifecycleStatus] || lifecycleConfig.intake_received;
    const Icon = lc.icon;
    return (
      <Badge
        variant={lc.variant}
        className={`gap-1 font-body text-xs ${lc.colorClass} ${className || ""}`}
      >
        <Icon
          className={`h-3 w-3 ${lifecycleStatus === "extracting" ? "animate-spin" : ""}`}
        />
        {lc.label}
      </Badge>
    );
  }

  const config = statusConfig[status] || statusConfig.uploaded;
  const Icon = config.icon;

  return (
    <Badge
      variant={config.variant}
      className={`gap-1 font-body text-xs ${
        status === "processed" ? "bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200" : ""
      } ${className || ""}`}
    >
      <Icon
        className={`h-3 w-3 ${status === "processing" ? "animate-spin" : ""}`}
      />
      {config.label}
    </Badge>
  );
};

export default ProcessingStatusBadge;
