import { beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";

const userFindUnique = vi.fn();
const userCreate = vi.fn();
const organizationFindUnique = vi.fn();
const organizationCreate = vi.fn();
const membershipCreate = vi.fn();
const transactionMock = vi.fn();

vi.mock("../src/core/db/prisma.js", () => ({
  prisma: {
    user: {
      findUnique: userFindUnique,
      create: userCreate,
      count: vi.fn().mockResolvedValue(1),
      update: vi.fn(),
      findFirst: vi.fn(),
    },
    organization: {
      findUnique: organizationFindUnique,
      create: organizationCreate,
    },
    membership: {
      create: membershipCreate,
      findMany: vi.fn().mockResolvedValue([]),
    },
    $transaction: transactionMock,
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

  userFindUnique.mockResolvedValue(null);
  organizationFindUnique.mockResolvedValue(null);

  organizationCreate.mockResolvedValue({
    id: "org-skyline",
    name: "Skyline Events Co.",
    slug: "skyline-events-co",
  });

  userCreate.mockResolvedValue({
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

  membershipCreate.mockResolvedValue({
    id: "mem-1",
    organizationId: "org-skyline",
    userId: "usr-organizer-1",
    role: "owner",
  });

  transactionMock.mockImplementation(async (callback: (tx: unknown) => unknown) =>
    callback({
      organization: { create: organizationCreate },
      user: { create: userCreate },
      membership: { create: membershipCreate },
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

    expect(organizationCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          name: "Skyline Events Co.",
          ownerEmail: "owner@skyline.test",
          contactEmail: "owner@skyline.test",
          status: "active",
        }),
      }),
    );
    expect(userCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          organizationId: "org-skyline",
          email: "owner@skyline.test",
          role: "uploader",
          displayName: "Alex Rivera",
        }),
      }),
    );
    expect(membershipCreate).toHaveBeenCalledWith(
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
    userFindUnique.mockResolvedValueOnce({
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
    expect(transactionMock).not.toHaveBeenCalled();
  });
});