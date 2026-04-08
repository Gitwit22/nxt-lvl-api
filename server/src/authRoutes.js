import express from "express";
import { prisma } from "./db.js";
import { hashPassword, verifyPassword, signToken, requireAuth, requireRole, getRequestUser, } from "./auth.js";
import { CURRENT_PROGRAM_DOMAIN } from "./config.js";
import { logger } from "./logger.js";
import { getDefaultTenantScope, getTenantScopeForUser } from "./tenant.js";
const router = express.Router();
// POST /api/auth/login
router.post("/login", async (req, res) => {
    const body = req.body;
    const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
    const password = typeof body.password === "string" ? body.password : "";
    if (!email || !password) {
        res.status(400).json({ error: "Email and password are required" });
        return;
    }
    const user = await prisma.user.findUnique({ where: { email } });
    if (!user) {
        // Constant-time comparison even on miss — avoids user enumeration
        await bcryptFakeCompare();
        res.status(401).json({ error: "Invalid credentials" });
        return;
    }
    const valid = await verifyPassword(password, user.passwordHash);
    if (!valid) {
        res.status(401).json({ error: "Invalid credentials" });
        return;
    }
    const tenantScope = getTenantScopeForUser(user);
    const token = signToken({
        userId: user.id,
        email: user.email,
        role: user.role,
        organizationId: tenantScope.organizationId,
        programDomain: CURRENT_PROGRAM_DOMAIN,
    });
    logger.info("User logged in", {
        userId: user.id,
        role: user.role,
        organizationId: tenantScope.organizationId,
        programDomain: CURRENT_PROGRAM_DOMAIN,
    });
    res.json({
        token,
        user: {
            id: user.id,
            email: user.email,
            role: user.role,
            displayName: user.displayName,
            organizationId: tenantScope.organizationId,
            programDomain: CURRENT_PROGRAM_DOMAIN,
        },
    });
});
// POST /api/auth/register  (admin only after first user)
router.post("/register", (req, res, next) => {
    // First user can self-register (bootstrapping); subsequent registrations require admin
    void prisma.user
        .count()
        .then((count) => {
        if (count === 0)
            return next(); // allow first user
        requireAuth(req, res, () => requireRole("admin")(req, res, next));
    })
        .catch(next);
}, async (req, res) => {
    const body = req.body;
    const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
    const password = typeof body.password === "string" ? body.password : "";
    const displayName = typeof body.displayName === "string" ? body.displayName.trim() : "";
    const role = typeof body.role === "string" &&
        ["admin", "reviewer", "uploader"].includes(body.role)
        ? body.role
        : "uploader";
    if (!email || !password) {
        res.status(400).json({ error: "Email and password are required" });
        return;
    }
    if (password.length < 8) {
        res.status(400).json({ error: "Password must be at least 8 characters" });
        return;
    }
    const existing = await prisma.user.findUnique({ where: { email } });
    if (existing) {
        res.status(409).json({ error: "A user with that email already exists" });
        return;
    }
    const passwordHash = await hashPassword(password);
    const tenantScope = getRequestUser(req)
        ? getTenantScopeForUser(getRequestUser(req))
        : getDefaultTenantScope();
    const user = await prisma.user.create({
        data: {
            organizationId: tenantScope.organizationId,
            email,
            passwordHash,
            role,
            displayName,
        },
    });
    logger.info("User registered", {
        userId: user.id,
        role: user.role,
        organizationId: tenantScope.organizationId,
        programDomain: CURRENT_PROGRAM_DOMAIN,
    });
    res.status(201).json({
        user: {
            id: user.id,
            email: user.email,
            role: user.role,
            displayName: user.displayName,
            organizationId: tenantScope.organizationId,
            programDomain: CURRENT_PROGRAM_DOMAIN,
        },
    });
});
// GET /api/auth/me
router.get("/me", requireAuth, async (req, res) => {
    const payload = getRequestUser(req);
    if (!payload) {
        res.status(401).json({ error: "Not authenticated" });
        return;
    }
    const user = await prisma.user.findUnique({ where: { id: payload.userId } });
    if (!user) {
        res.status(404).json({ error: "User not found" });
        return;
    }
    res.json({
        user: {
            id: user.id,
            email: user.email,
            role: user.role,
            displayName: user.displayName,
            organizationId: user.organizationId,
            programDomain: CURRENT_PROGRAM_DOMAIN,
        },
    });
});
// Timing-safe dummy hash comparison to prevent user enumeration on login miss
async function bcryptFakeCompare() {
    await verifyPassword("dummy", "$2a$12$invalidhashpaddingtomakeittimeconstant00000000000000000");
}
export { router as authRouter };
