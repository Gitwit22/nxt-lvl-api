import express from "express";
import { getRequestUser } from "../../../core/auth/auth.service.js";
import { requireAuth } from "../../../core/middleware/auth.middleware.js";
import { eventureEventsRouter } from "./events.routes.js";
import { eventureAttendeesRouter } from "./attendees.routes.js";
import { eventureRegistrationsRouter } from "./registrations.routes.js";
import { eventureCheckInsRouter } from "./checkins.routes.js";
import { eventureSponsorImportsRouter } from "./sponsor-imports.routes.js";
import { eventureSponsorImportsOrgRouter } from "./sponsor-imports-org.routes.js";
import { eventureAttendeeImportsRouter } from "./attendee-imports.routes.js";
import { eventureParticipantRevenueImportsRouter } from "./participant-revenue-imports.routes.js";
import { eventureUnmatchedRevenueRouter } from "./unmatched-revenue.routes.js";
import { eventureSponsorsRouter } from "./sponsors.routes.js";
import { eventurePackagesRouter } from "./packages.routes.js";
import { eventurePriceOptionsRouter } from "./price-options.routes.js";
import { eventurePaymentImportRouter } from "./payment-import.routes.js";
import { eventureHistoryRouter } from "./history.routes.js";
import { eventureReportsRouter } from "./reports.routes.js";
import { eventureSharedRouter } from "./shared.routes.js";
import { ordersRouter } from "./orders.routes.js";
import { eventureWorkspaceRouter } from "./workspace.routes.js";
import { eventureTasksRouter } from "./tasks.routes.js";
import { eventurePersonnelRouter } from "./personnel.routes.js";
import { eventurePersonnelInvitesRouter } from "./personnel-invites.routes.js";
import { eventureEventPersonnelRouter } from "./event-personnel.routes.js";
import { eventureVolunteerContactsRouter } from "./volunteer-contacts.routes.js";
import { eventureEventVolunteerContactsRouter } from "./event-volunteer-contacts.routes.js";

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
router.use("/events/:eventId/attendee-imports", eventureAttendeeImportsRouter);
router.use("/events/:eventId/participant-revenue-imports", eventureParticipantRevenueImportsRouter);
router.use("/events/:eventId/unmatched-revenue", eventureUnmatchedRevenueRouter);
router.use("/events/:eventId/sponsors/payment-import", eventurePaymentImportRouter);
router.use("/events/:eventId/sponsors", eventureSponsorsRouter);
router.use("/events/:eventId/packages", eventurePackagesRouter);
router.use("/events/:eventId/price-options", eventurePriceOptionsRouter);
router.use("/events/:eventId/history", eventureHistoryRouter);
router.use("/events/:eventId/reports", eventureReportsRouter);
router.use("/events/:eventId/workspace", eventureWorkspaceRouter);
router.use("/events/:eventId/personnel", eventureEventPersonnelRouter);
router.use("/events/:eventId/volunteer-contacts", eventureEventVolunteerContactsRouter);
router.use("/tasks", eventureTasksRouter);
router.use("/sponsor-imports", eventureSponsorImportsOrgRouter);
router.use("/shared", eventureSharedRouter);
router.use("/registrations", eventureRegistrationsRouter);
router.use("/orders", ordersRouter);
router.use("/personnel", eventurePersonnelRouter);
router.use("/volunteer-contacts", eventureVolunteerContactsRouter);
router.use("/invites", eventurePersonnelInvitesRouter);

export { router as eventureRouter };