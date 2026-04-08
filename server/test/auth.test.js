import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
vi.mock("../src/db.js", () => ({
    prisma: {
        user: {
            findUnique: vi.fn(),
            count: vi.fn().mockResolvedValue(1),
            create: vi.fn(),
        },
    },
}));
import { app } from "../src/app.js";
import { prisma } from "../src/db.js";
import { hashPassword } from "../src/auth.js";
import { signToken } from "../src/auth.js";
vi.mock("../src/processingQueue.js", () => ({
    enqueueProcessing: vi.fn().mockResolvedValue(undefined),
}));
const adminToken = () => `Bearer ${signToken({ userId: "admin-1", email: "admin@test.com", role: "admin" })}`;
beforeEach(() => vi.clearAllMocks());
describe("POST /api/auth/login", () => {
    it("returns 400 if email or password missing", async () => {
        const res = await request(app).post("/api/auth/login").send({ email: "x@x.com" });
        expect(res.status).toBe(400);
    });
    it("returns 401 for unknown user", async () => {
        prisma.user.findUnique.mockResolvedValueOnce(null);
        const res = await request(app)
            .post("/api/auth/login")
            .send({ email: "nobody@example.com", password: "password123" });
        expect(res.status).toBe(401);
        expect(res.body.error).toMatch(/invalid credentials/i);
    });
    it("returns 401 for wrong password", async () => {
        const hash = await hashPassword("correct-password");
        prisma.user.findUnique.mockResolvedValueOnce({
            id: "u-1",
            organizationId: "default-org",
            email: "user@example.com",
            passwordHash: hash,
            role: "reviewer",
            displayName: "Reviewer",
        });
        const res = await request(app)
            .post("/api/auth/login")
            .send({ email: "user@example.com", password: "wrong-password" });
        expect(res.status).toBe(401);
    });
    it("returns token for valid credentials", async () => {
        const hash = await hashPassword("correct-password");
        prisma.user.findUnique.mockResolvedValueOnce({
            id: "u-1",
            organizationId: "default-org",
            email: "user@example.com",
            passwordHash: hash,
            role: "reviewer",
            displayName: "Reviewer",
        });
        const res = await request(app)
            .post("/api/auth/login")
            .send({ email: "user@example.com", password: "correct-password" });
        expect(res.status).toBe(200);
        expect(res.body.token).toBeDefined();
        expect(typeof res.body.token).toBe("string");
        expect(res.body.user.role).toBe("reviewer");
        // Never expose passwordHash
        expect(res.body.user.passwordHash).toBeUndefined();
    });
});
describe("POST /api/auth/register", () => {
    it("allows first user to self-register (count=0)", async () => {
        prisma.user.count.mockResolvedValueOnce(0);
        prisma.user.findUnique.mockResolvedValueOnce(null);
        prisma.user.create.mockResolvedValueOnce({
            id: "u-new",
            organizationId: "default-org",
            email: "first@test.com",
            role: "admin",
            displayName: "First Admin",
        });
        const res = await request(app).post("/api/auth/register").send({
            email: "first@test.com",
            password: "secure-pass-1",
            role: "admin",
            displayName: "First Admin",
        });
        expect(res.status).toBe(201);
        expect(res.body.user.email).toBe("first@test.com");
        expect(res.body.user.passwordHash).toBeUndefined();
    });
    it("requires admin token when users already exist", async () => {
        prisma.user.count.mockResolvedValueOnce(5);
        const res = await request(app).post("/api/auth/register").send({
            email: "new@test.com",
            password: "secure-pass-1",
        });
        expect(res.status).toBe(401);
    });
    it("returns 400 for short password", async () => {
        prisma.user.count.mockResolvedValueOnce(0);
        const res = await request(app).post("/api/auth/register").send({
            email: "x@test.com",
            password: "short",
        });
        expect(res.status).toBe(400);
        expect(res.body.error).toMatch(/8 characters/i);
    });
    it("returns 409 if email already exists", async () => {
        prisma.user.count.mockResolvedValueOnce(0);
        prisma.user.findUnique.mockResolvedValueOnce({
            id: "u-1",
            email: "taken@test.com",
        });
        const res = await request(app).post("/api/auth/register").send({
            email: "taken@test.com",
            password: "securepassword",
        });
        expect(res.status).toBe(409);
    });
});
describe("GET /api/auth/me", () => {
    it("returns 401 without token", async () => {
        const res = await request(app).get("/api/auth/me");
        expect(res.status).toBe(401);
    });
    it("returns user profile for valid token", async () => {
        prisma.user.findUnique.mockResolvedValueOnce({
            id: "admin-1",
            organizationId: "default-org",
            email: "admin@test.com",
            role: "admin",
            displayName: "Admin",
        });
        const res = await request(app).get("/api/auth/me").set("Authorization", adminToken());
        expect(res.status).toBe(200);
        expect(res.body.user.email).toBe("admin@test.com");
        expect(res.body.user.organizationId).toBe("default-org");
        expect(res.body.user.programDomain).toBe("community-chronicle");
        expect(res.body.user.passwordHash).toBeUndefined();
    });
});
