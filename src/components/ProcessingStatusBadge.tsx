/**
 * Processing Status Badge Component
 *
 * Displays the processing status of a document with appropriate
 * colors and icons for each status.
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
} from "lucide-react";
import type { ProcessingStatus } from "@/types/document";

interface ProcessingStatusBadgeProps {
  status: ProcessingStatus;
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

const ProcessingStatusBadge = ({ status, className }: ProcessingStatusBadgeProps) => {
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
