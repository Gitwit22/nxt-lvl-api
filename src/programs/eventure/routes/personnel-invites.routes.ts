import express from "express";
import { validateEventureInviteToken, acceptEventureInvite, EventureInviteServiceError } from "../services/eventure-invite.service.js";

const router = express.Router();

function handleError(res: express.Response, error: unknown) {
  if (error instanceof EventureInviteServiceError) {
    const body: Record<string, unknown> = { error: error.message, code: error.code };
    if (error.retryAfterSeconds !== undefined) {
      res.set("Retry-After", String(error.retryAfterSeconds));
      body.retryAfterSeconds = error.retryAfterSeconds;
    }
    res.status(error.status).json(body);
    return;
  }
  console.error("[eventure:invites]", error);
  res.status(500).json({ error: "Internal server error" });
}

// GET /api/eventure/invites/validate?token=<rawToken>
router.get("/validate", async (req, res) => {
  try {
    const token = typeof req.query.token === "string" ? req.query.token.trim() : undefined;
    if (!token) { res.status(400).json({ error: "token is required" }); return; }

    const metadata = await validateEventureInviteToken(token);
    res.json({ invite: metadata });
  } catch (error) { handleError(res, error); }
});

// POST /api/eventure/invites/accept — create account + link personnel
router.post("/accept", async (req, res) => {
  try {
    const { token, password, displayName } = req.body as {
      token?: string;
      password?: string;
      displayName?: string;
    };

    if (!token?.trim()) { res.status(400).json({ error: "token is required" }); return; }
    if (!password || password.length < 8) {
      res.status(400).json({ error: "password must be at least 8 characters" });
      return;
    }

    const result = await acceptEventureInvite({ rawToken: token.trim(), password, displayName });
    res.status(201).json({ ok: true, userId: result.userId, email: result.email });
  } catch (error) { handleError(res, error); }
});

export { router as eventurePersonnelInvitesRouter };
