import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";

vi.mock("../src/core/db/prisma.js", () => ({
  prisma: {
    user: {
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      update: vi.fn(),
      count: vi.fn().mockResolvedValue(1),
      create: vi.fn(),
    },
  },
}));

import { app } from "../src/app.js";
import { prisma } from "../src/core/db/prisma.js";
import { signToken } from "../src/auth.js";

const prismaMock = prisma as unknown as {
  user: {
    findUnique: ReturnType<typeof vi.fn>;
    findFirst: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
    count: ReturnType<typeof vi.fn>;
    create: ReturnType<typeof vi.fn>;
  };
};

vi.mock("../src/processingQueue.js", () => ({
  enqueueProcessing: vi.fn().mockResolvedValue(undefined),
}));

const adminToken = () =>
  `Bearer ${signToken({ userId: "admin-1", email: "admin@test.com", role: "admin" })}`;

beforeEach(() => {
  vi.resetAllMocks();
  prismaMock.user.count.mockResolvedValue(1);
  prismaMock.user.findUnique.mockResolvedValue(null);
  prismaMock.user.findFirst.mockResolvedValue(null);
  prismaMock.user.update.mockResolvedValue(null);
  prismaMock.user.create.mockResolvedValue(null);
});

describe("POST /api/auth/login", () => {
  it("rejects direct local login when app authMode is platform_only", async () => {
    const res = await request(app)
      .post("/api/auth/login")
      .send({ email: "user@example.com", password: "password123" });

    expect(res.status).toBe(403);
    expect(res.body.code).toBe("suite_login_required");
  });

  it("rejects Suite partition login when authMode is platform_only", async () => {
    const res = await request(app)
      .post("/api/auth/login")
      .set("x-app-partition", "nxt-lvl-suites")
      .send({ email: "user@example.com", password: "password123" });

    expect(res.status).toBe(403);
    expect(res.body.code).toBe("suite_login_required");
  });
});

describe("POST /api/auth/register", () => {
  it("rejects direct local registration when app authMode is platform_only", async () => {
    const res = await request(app).post("/api/auth/register").send({
      email: "new@test.com",
      password: "secure-pass-1",
    });

    expect(res.status).toBe(403);
    expect(res.body.code).toBe("suite_login_required");
  });

  it("rejects Suite partition registration when authMode is platform_only", async () => {
    const res = await request(app)
      .post("/api/auth/register")
      .set("x-app-partition", "nxt-lvl-suites")
      .send({ email: "new@test.com", password: "password123" });

    expect(res.status).toBe(403);
    expect(res.body.code).toBe("suite_login_required");
  });
});

describe("GET /api/auth/me", () => {
  it("returns 401 without token", async () => {
    const res = await request(app).get("/api/auth/me");
    expect(res.status).toBe(401);
  });

  it("returns user profile for valid token", async () => {
    prismaMock.user.findUnique.mockResolvedValueOnce({
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
