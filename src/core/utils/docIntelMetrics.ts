/**
 * Document Intelligence Metrics Collector
 *
 * Collects performance, reliability, and usage metrics for document intelligence
 * operations. Supports tracking provider performance, fallback triggers, and
 * end-to-end latency for both direct calls and queue-based processing.
 *
 * Metrics are stored in a fixed-size ring buffer (preserving last 1000 operations)
 * and exported via /api/metrics/doc-intel endpoint.
 */

export type MetricsOperation = "parse" | "classify" | "extract" | "process";
export type MetricsProvider = "core-api" | "rule-based-fallback" | "failed";

export interface DocIntelMetric {
  timestamp: number; // Unix timestamp
  operation: MetricsOperation;
  provider: MetricsProvider;
  durationMs: number;
  success: boolean;
  fallbackTriggered?: boolean;
  fallbackReason?: string;
  statusCode?: number;
  documentType?: string;
  documentId?: string;
  jobId?: string;
  errorMessage?: string;
}

const DEFAULT_RING_BUFFER_SIZE = 1000;

export class DocIntelMetricsCollector {
  private metrics: DocIntelMetric[] = [];
  private maxSize: number;

  constructor(maxSize = DEFAULT_RING_BUFFER_SIZE) {
    this.maxSize = maxSize;
  }

  /**
   * Record a document intelligence metric.
   */
  record(metric: DocIntelMetric): void {
    this.metrics.push(metric);
    if (this.metrics.length > this.maxSize) {
      this.metrics.shift();
    }
  }

  /**
   * Get all metrics currently in the buffer.
   */
  getAll(): DocIntelMetric[] {
    return [...this.metrics];
  }

  /**
   * Get metrics filtered by operation type.
   */
  getByOperation(operation: MetricsOperation): DocIntelMetric[] {
    return this.metrics.filter((m) => m.operation === operation);
  }

  /**
   * Get metrics filtered by provider.
   */
  getByProvider(provider: MetricsProvider): DocIntelMetric[] {
    return this.metrics.filter((m) => m.provider === provider);
  }

  /**
   * Compute statistics for a subset of metrics.
   */
  static computeStats(metrics: DocIntelMetric[]) {
    if (metrics.length === 0) {
      return null;
    }

    const durations = metrics.map((m) => m.durationMs).sort((a, b) => a - b);
    const successCount = metrics.filter((m) => m.success).length;
    const fallbackCount = metrics.filter((m) => m.fallbackTriggered).length;

    return {
      count: metrics.length,
      successCount,
      failureCount: metrics.length - successCount,
      successRate: (successCount / metrics.length) * 100,
      fallbackCount,
      fallbackRate: (fallbackCount / metrics.length) * 100,
      avgDurationMs: durations.reduce((a, b) => a + b, 0) / durations.length,
      medianDurationMs: durations[Math.floor(durations.length / 2)],
      p95DurationMs: durations[Math.floor(durations.length * 0.95)],
      p99DurationMs: durations[Math.floor(durations.length * 0.99)],
      minDurationMs: durations[0],
      maxDurationMs: durations[durations.length - 1],
    };
  }

  /**
   * Get statistics for all metrics.
   */
  getStats() {
    return {
      total: DocIntelMetricsCollector.computeStats(this.metrics),
      byOperation: {
        parse: DocIntelMetricsCollector.computeStats(this.getByOperation("parse")),
        classify: DocIntelMetricsCollector.computeStats(this.getByOperation("classify")),
        extract: DocIntelMetricsCollector.computeStats(this.getByOperation("extract")),
        process: DocIntelMetricsCollector.computeStats(this.getByOperation("process")),
      },
      byProvider: {
        "core-api": DocIntelMetricsCollector.computeStats(this.getByProvider("core-api")),
        "rule-based-fallback": DocIntelMetricsCollector.computeStats(
          this.getByProvider("rule-based-fallback"),
        ),
        failed: DocIntelMetricsCollector.computeStats(this.getByProvider("failed")),
      },
    };
  }

  /**
   * Clear all metrics from the buffer.
   */
  clear(): void {
    this.metrics = [];
  }

  /**
   * Reset statistics (clear history).
   */
  reset(): void {
    this.clear();
  }
}

// Global singleton instance
export const globalDocIntelMetrics = new DocIntelMetricsCollector();
