import jwt from "jsonwebtoken";
import bcrypt from "bcryptjs";
import { CURRENT_PROGRAM_DOMAIN, DEFAULT_ORGANIZATION_ID, JWT_SECRET, JWT_EXPIRES_IN } from "./config.js";
const ROLE_LEVEL = { uploader: 1, reviewer: 2, admin: 3 };
// --- Password helpers ---
export async function hashPassword(plaintext) {
    return bcrypt.hash(plaintext, 12);
}
export async function verifyPassword(plaintext, hash) {
    return bcrypt.compare(plaintext, hash);
}
// --- Token helpers ---
export function signToken(payload) {
    return jwt.sign({
        ...payload,
        organizationId: payload.organizationId || DEFAULT_ORGANIZATION_ID,
        programDomain: payload.programDomain || CURRENT_PROGRAM_DOMAIN,
    }, JWT_SECRET, { expiresIn: JWT_EXPIRES_IN });
}
export function decodeToken(token) {
    return jwt.verify(token, JWT_SECRET);
}
// --- Request helpers (avoids global augmentation complexity) ---
export function getRequestUser(req) {
    return req._authUser;
}
function setRequestUser(req, user) {
    req._authUser = user;
}
// --- Middleware ---
export function requireAuth(req, res, next) {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith("Bearer ")) {
        res.status(401).json({ error: "Authentication required" });
        return;
    }
    const token = authHeader.slice(7);
    try {
        const payload = decodeToken(token);
        if (!payload.organizationId || !payload.programDomain) {
            res.status(401).json({ error: "Invalid tenant context" });
            return;
        }
        if (payload.programDomain !== CURRENT_PROGRAM_DOMAIN) {
            res.status(403).json({ error: "Program access denied" });
            return;
        }
        setRequestUser(req, payload);
        next();
    }
    catch {
        res.status(401).json({ error: "Invalid or expired token" });
    }
}
export function requireRole(minRole) {
    return (req, res, next) => {
        const user = getRequestUser(req);
        if (!user) {
            res.status(401).json({ error: "Authentication required" });
            return;
        }
        const userLevel = ROLE_LEVEL[user.role] ?? 0;
        const requiredLevel = ROLE_LEVEL[minRole];
        if (userLevel < requiredLevel) {
            res.status(403).json({ error: "Insufficient permissions" });
            return;
        }
        next();
    };
}
