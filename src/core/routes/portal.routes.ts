/**
 * portal.routes.ts — DEPRECATED
 *
 * The org portal model has been removed. All portal functionality is now
 * delivered through the Suite workspace at /orgs/:orgSlug/*.
 *
 * Backwards-compat shims:
 *   GET  /api/portal/bootstrap       → 301 /api/orgs/bootstrap
 *   POST /api/portal/:orgId/provision → 301 /api/orgs/:orgId/provision
 *
 * These routes exist only so that any cached clients or older builds
 * don't hard-fail. Remove after 2026-Q3.
 */
import express from "express";

const router = express.Router();

router.get("/bootstrap", (req, res) => {
  const qs = req.url.includes("?") ? req.url.slice(req.url.indexOf("?")) : "";
  res.redirect(301, `/api/orgs/bootstrap${qs}`);
});

router.post("/:orgId/provision", (req, res) => {
  res.redirect(308, `/api/orgs/${req.params.orgId}/provision`);
});

export { router as portalRouter };
