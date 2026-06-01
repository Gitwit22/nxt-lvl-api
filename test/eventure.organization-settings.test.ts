import express from "express";
import request from "supertest";
import jwt from "jsonwebtoken";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { JWT_SECRET } from "../src/core/config/env.js";
import { CURRENT_PROGRAM_DOMAIN } from "../src/core/config/env.js";

const prismaMock = vi.hoisted(() => ({
  organization: {
    findUnique: vi.fn(),
    update: vi.fn(),
  },
  programStorageSettings: {
    findUnique: vi.fn(),
    upsert: vi.fn(),
  },
  membership: {
    findFirst: vi.fn(),
  },
}));

vi.mock("../src/core/db/prisma.js", () => ({
  prisma: prismaMock,
}));

vi.mock("../src/core/services/orgProvisioning.js", () => ({
  provisionCommunityChroniclePartition: vi.fn(),
  provisionOrgSubscriptions: vi.fn(),
  provisionOrgFromAssignedIds: vi.fn(),
  provisionUserProgramAccessFromOrgSubscriptions: vi.fn(),
}));

const { organizationRouter } = await import("../src/core/routes/organization.routes.js");

const app = express();
app.use(express.json());
app.use("/api/orgs", organizationRouter);

const authToken = jwt.sign(
  {
    userId: "user-1",
    email: "admin@example.com",
    role: "admin",
    platformRole: "suite_admin",
    organizationId: "org-1",
    programDomain: CURRENT_PROGRAM_DOMAIN,
  },
  JWT_SECRET,
);

beforeEach(() => {
  vi.clearAllMocks();

  prismaMock.organization.findUnique.mockResolvedValue({
    id: "org-1",
    name: "Eventure Org",
    slug: "eventure-org",
    isActive: true,
    status: "active",
    planType: "starter",
    seatLimit: 25,
    assignedBundleIds: [],
    assignedProgramIds: [],
  });
  prismaMock.organization.update.mockImplementation(async (_args: unknown) => ({
    id: "org-1",
    name: "Eventure Org Updated",
    slug: "eventure-org-updated",
    isActive: true,
    status: "active",
    planType: "starter",
    seatLimit: 25,
    assignedBundleIds: [],
    assignedProgramIds: [],
  }));
  prismaMock.programStorageSettings.findUnique.mockResolvedValue(null);
  prismaMock.programStorageSettings.upsert.mockImplementation(async (args: Record<string, unknown>) => ({
    settings: (args.create as { settings: unknown }).settings,
  }));
});

describe("Eventure org settings", () => {
  it("returns default settings when no saved row exists", async () => {
    const response = await request(app)
      .get("/api/orgs/org-1/app-settings")
      .set("Authorization", `Bearer ${authToken}`);

    expect(response.status).toBe(200);
    expect(response.body.organization.id).toBe("org-1");
    expect(response.body.settings.rollbackSettings).toEqual({
      defaultMode: "archive",
      allowHardDelete: false,
      requireConfirmationText: true,
    });
    expect(prismaMock.programStorageSettings.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          organizationId_programDomain: {
            organizationId: "org-1",
            programDomain: "eventure",
          },
        },
      }),
    );
  });

  it("persists rollback settings and organization fields", async () => {
    const response = await request(app)
      .put("/api/orgs/org-1/app-settings")
      .set("Authorization", `Bearer ${authToken}`)
      .send({
        organization: {
          name: "Eventure Org Updated",
          slug: "eventure-org-updated",
        },
        settings: {
          rollbackSettings: {
            defaultMode: "hard_delete",
            allowHardDelete: true,
            requireConfirmationText: false,
          },
          importSettings: {
            dryRunByDefault: false,
          },
        },
      });

    expect(response.status).toBe(200);
    expect(prismaMock.organization.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "org-1" },
        data: expect.objectContaining({
          name: "Eventure Org Updated",
          slug: "eventure-org-updated",
        }),
      }),
    );
    expect(prismaMock.programStorageSettings.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          organizationId_programDomain: {
            organizationId: "org-1",
            programDomain: "eventure",
          },
        },
        create: expect.objectContaining({
          organizationId: "org-1",
          programDomain: "eventure",
          settings: expect.objectContaining({
            importSettings: expect.objectContaining({
              dryRunByDefault: false,
            }),
            rollbackSettings: expect.objectContaining({
              defaultMode: "hard_delete",
              allowHardDelete: true,
              requireConfirmationText: false,
            }),
          }),
        }),
      }),
    );
    expect(response.body.settings.rollbackSettings).toEqual({
      defaultMode: "hard_delete",
      allowHardDelete: true,
      requireConfirmationText: false,
    });
  });
});