import { beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";

const prismaMocks = vi.hoisted(() => ({
  userFindUnique: vi.fn(),
  userCreate: vi.fn(),
  organizationFindUnique: vi.fn(),
  organizationCreate: vi.fn(),
  membershipCreate: vi.fn(),
  transactionMock: vi.fn(),
}));

vi.mock("../src/core/db/prisma.js", () => ({
  prisma: {
    user: {
      findUnique: prismaMocks.userFindUnique,
      create: prismaMocks.userCreate,
      count: vi.fn().mockResolvedValue(1),
      update: vi.fn(),
      findFirst: vi.fn(),
    },
    organization: {
      findUnique: prismaMocks.organizationFindUnique,
      create: prismaMocks.organizationCreate,
    },
    membership: {
      create: prismaMocks.membershipCreate,
      findMany: vi.fn().mockResolvedValue([]),
    },
    $transaction: prismaMocks.transactionMock,
  },
}));

vi.mock("../src/processingQueue.js", () => ({
  enqueueProcessing: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../src/core/services/orgProvisioning.js", () => ({
  provisionUserProgramAccessFromOrgSubscriptions: vi.fn().mockResolvedValue({ granted: 0 }),
}));

import { app } from "../src/app.js";

beforeEach(() => {
  vi.clearAllMocks();

  prismaMocks.userFindUnique.mockResolvedValue(null);
  prismaMocks.organizationFindUnique.mockResolvedValue(null);

  prismaMocks.organizationCreate.mockResolvedValue({
    id: "org-skyline",
    name: "Skyline Events Co.",
    slug: "skyline-events-co",
  });

  prismaMocks.userCreate.mockResolvedValue({
    id: "usr-organizer-1",
    email: "owner@skyline.test",
    role: "uploader",
    platformRole: "user",
    displayName: "Alex Rivera",
    organizationId: "org-skyline",
    organizationName: "Skyline Events Co.",
    passwordHash: "hashed-password",
    identitySource: "local",
    mustChangePassword: false,
  });

  prismaMocks.membershipCreate.mockResolvedValue({
    id: "mem-1",
    organizationId: "org-skyline",
    userId: "usr-organizer-1",
    role: "owner",
  });

  prismaMocks.transactionMock.mockImplementation(async (callback: (tx: unknown) => unknown) =>
    callback({
      organization: { create: prismaMocks.organizationCreate },
      user: { create: prismaMocks.userCreate },
      membership: { create: prismaMocks.membershipCreate },
    }),
  );
});

describe("POST /api/auth/organizer/signup", () => {
  it("creates an organization owner account and returns an authenticated payload", async () => {
    const response = await request(app)
      .post("/api/auth/organizer/signup")
      .set("x-app-partition", "eventure")
      .send({
        orgName: "Skyline Events Co.",
        contactName: "Alex Rivera",
        contactEmail: "owner@skyline.test",
        phone: "(555) 555-1000",
        website: "https://skyline.test",
        businessType: "Promoter",
        bio: "Live events and seasonal festivals.",
        password: "SecurePass123",
      });

    expect(response.status).toBe(201);
    expect(response.body.user.email).toBe("owner@skyline.test");
    expect(response.body.user.organizationId).toBe("org-skyline");
    expect(response.body.user.organizationName).toBe("Skyline Events Co.");
    expect(response.body.user.orgMemberships).toEqual([
      expect.objectContaining({
        orgId: "org-skyline",
        orgName: "Skyline Events Co.",
        role: "owner",
      }),
    ]);
    expect(response.body.token).toEqual(expect.any(String));
    expect(response.body.appInitState).toBe("ready");

    expect(prismaMocks.organizationCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          name: "Skyline Events Co.",
          ownerEmail: "owner@skyline.test",
          contactEmail: "owner@skyline.test",
          status: "active",
        }),
      }),
    );
    expect(prismaMocks.userCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          organizationId: "org-skyline",
          email: "owner@skyline.test",
          role: "uploader",
          displayName: "Alex Rivera",
        }),
      }),
    );
    expect(prismaMocks.membershipCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          organizationId: "org-skyline",
          userId: "usr-organizer-1",
          role: "owner",
        }),
      }),
    );
  });

  it("rejects duplicate organizer emails", async () => {
    prismaMocks.userFindUnique.mockResolvedValueOnce({
      id: "existing-user",
      email: "owner@skyline.test",
    });

    const response = await request(app)
      .post("/api/auth/organizer/signup")
      .send({
        orgName: "Skyline Events Co.",
        contactName: "Alex Rivera",
        contactEmail: "owner@skyline.test",
        phone: "(555) 555-1000",
        password: "SecurePass123",
      });

    expect(response.status).toBe(409);
    expect(response.body.error).toMatch(/already exists/i);
    expect(prismaMocks.transactionMock).not.toHaveBeenCalled();
  });
});