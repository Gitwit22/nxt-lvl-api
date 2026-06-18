import express from "express";
import { getRequestUser } from "../../../core/auth/auth.service.js";
import { requireAuth } from "../../../core/middleware/auth.middleware.js";
import { EventureServiceError } from "../services/eventure-error.js";
import { OrgDashboardService } from "../services/org-dashboard.service.js";

const router = express.Router();

function setShortLivedReadCache(res: express.Response) {
  res.setHeader("Cache-Control", "private, max-age=15, stale-while-revalidate=45");
}

function handleError(res: express.Response, error: unknown) {
  if (error instanceof EventureServiceError) {
    res.status(error.statusCode).json({ error: error.message });
    return;
  }

  const message = error instanceof Error ? error.message : "Unknown server error";
  res.status(500).json({ error: message });
}

router.use(requireAuth);

router.get("/", async (req, res) => {
  try {
    const user = getRequestUser(req);
    const item = await OrgDashboardService.getSummary(user.organizationId);
    setShortLivedReadCache(res);
    res.json({ item });
  } catch (error) {
    handleError(res, error);
  }
});

export { router as eventureDashboardSummaryRouter };
