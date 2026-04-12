/**
 * platform-auth.routes.ts
 *
 * REMOVED — The suite→app JWT launch-token handoff flow has been retired.
 *
 * What was here:
 *   POST /api/auth/consume  — accepted a platform launch token, looked up or
 *   created a local user linked by platformUserId/identitySource, then issued
 *   a program-scoped JWT.
 *
 * Why it was removed:
 *   The handoff model required a shared PLATFORM_LAUNCH_TOKEN_SECRET across all
 *   apps, created a tight coupling between the suite auth session and every child
 *   app, and introduced race conditions / redirect loops before the data model
 *   was stable. All programs now use direct local authentication (email + password)
 *   and are gated by OrganizationProgramSubscription at the API level.
 *
 * What replaced it:
 *   - Local login: POST /api/auth/login (email + password)
 *   - Program access: OrganizationProgramSubscription rows managed by platform admin
 *   - User provisioning: POST /api/orgs/:orgId/users (admin issues temp password)
 *
 * The router export is kept as an empty router so that any lingering import in
 * app.ts does not cause a compile error while the import is being cleaned up.
 */
import express from "express";

const router = express.Router();
export { router as platformAuthRouter };
