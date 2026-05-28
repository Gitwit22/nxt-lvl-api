import express from "express";
import { getRequestUser } from "../../../core/auth/auth.service.js";
import { requireAuth } from "../../../core/middleware/auth.middleware.js";
import { eventureEventsRouter } from "./events.routes.js";
import { eventureAttendeesRouter } from "./attendees.routes.js";
import { eventureRegistrationsRouter } from "./registrations.routes.js";
import { eventureCheckInsRouter } from "./checkins.routes.js";
import { eventureSponsorImportsRouter } from "./sponsor-imports.routes.js";

const router = express.Router();

router.get("/health", (_req, res) => {
  res.json({
    program: "eventure",
    status: "ok",
  });
});

router.get("/bootstrap", requireAuth, (req, res) => {
  const user = getRequestUser(req);

  res.json({
    program: "eventure",
    organizationId: user?.organizationId ?? null,
    userId: user?.userId ?? null,
    role: user?.role ?? null,
  });
});

router.use("/events", eventureEventsRouter);
router.use("/events/:eventId/attendees", eventureAttendeesRouter);
router.use("/events/:eventId/checkins", eventureCheckInsRouter);
router.use("/events/:eventId/sponsor-imports", eventureSponsorImportsRouter);
router.use("/registrations", eventureRegistrationsRouter);

export { router as eventureRouter };