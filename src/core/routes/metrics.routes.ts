import { Router } from "express";

import { globalDocIntelMetrics } from "../../core/utils/docIntelMetrics.js";

const router = Router();

/**
 * GET /api/metrics/doc-intel
 *
 * Returns aggregated document intelligence metrics from the Core API client.
 * Includes overall stats, breakdowns by operation type (parse/classify/extract),
 * and breakdowns by provider (core-api / rule-based-fallback / failed).
 *
 * Query parameters:
 *   - operation: Filter by operation type (parse|classify|extract|process)
 *   - window: Not currently used (for future InfluxDB integration)
 *
 * Example response:
 * {
 *   "total": {
 *     "count": 450,
 *     "successCount": 442,
 *     "successRate": 98.2,
 *     "avgDurationMs": 521,
 *     "p95DurationMs": 1850,
 *     ...
 *   },
 *   "byOperation": {...},
 *   "byProvider": {...}
 * }
 */
router.get("/doc-intel", (_req, res) => {
  try {
    const stats = globalDocIntelMetrics.getStats();
    res.json({
      timestamp: new Date().toISOString(),
      stats,
    });
  } catch (error) {
    res.status(500).json({
      error: error instanceof Error ? error.message : "Failed to fetch metrics",
    });
  }
});

/**
 * GET /api/metrics/doc-intel/export
 *
 * Exports all raw metrics as JSON for archival, debugging, or analysis.
 * Includes full metric details (timestamps, document IDs, error messages, etc.).
 */
router.get("/doc-intel/export", (_req, res) => {
  try {
    const metrics = globalDocIntelMetrics.getAll();
    const stats = globalDocIntelMetrics.getStats();

    res.json({
      exportedAt: new Date().toISOString(),
      metricsCount: metrics.length,
      metrics,
      aggregatedStats: stats,
    });
  } catch (error) {
    res.status(500).json({
      error: error instanceof Error ? error.message : "Failed to export metrics",
    });
  }
});

/**
 * POST /api/metrics/doc-intel/clear
 *
 * Clears all metrics from the buffer (useful for testing or after deployments).
 * Requires admin role (TODO: add authorization check).
 */
router.post("/doc-intel/clear", (_req, res) => {
  try {
    globalDocIntelMetrics.clear();
    res.json({
      message: "Metrics buffer cleared",
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    res.status(500).json({
      error: error instanceof Error ? error.message : "Failed to clear metrics",
    });
  }
});

export { router as metricsRouter };
