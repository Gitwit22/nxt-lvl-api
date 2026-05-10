import { beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import { signToken } from "../src/auth.js";

const prismaMock = vi.hoisted(() => ({
  organizationProgramSubscription: {
    findUnique: vi.fn().mockResolvedValue({ status: "active" }),
  },
  financialHubUserProfile: {
    count: vi.fn().mockResolvedValue(1),
    findFirst: vi.fn().mockResolvedValue(null),
    upsert: vi.fn(),
    create: vi.fn(),
  },
  financeIntakeRecord: {
    findMany: vi.fn().mockResolvedValue([]),
    create: vi.fn(),
    update: vi.fn(),
    findFirst: vi.fn(),
    groupBy: vi.fn().mockResolvedValue([]),
    aggregate: vi.fn().mockResolvedValue({ _count: { _all: 0 }, _sum: { amount: 0 } }),
  },
  financeHubDocument: {
    create: vi.fn(),
    findMany: vi.fn().mockResolvedValue([]),
    findFirst: vi.fn(),
    update: vi.fn(),
  },
  programStorageSettings: {
    findUnique: vi.fn().mockResolvedValue(null),
    upsert: vi.fn(),
  },
  user: {
    findUnique: vi.fn().mockResolvedValue({ id: "user-1", email: "user@test.com", role: "admin" }),
    create: vi.fn(),
  },
  organization: {
    create: vi.fn(),
  },
  membership: {
    create: vi.fn(),
  },
  userProgramAccess: {
    upsert: vi.fn(),
  },
  $transaction: vi.fn(),
}));

const uploadMock = vi.hoisted(() => vi.fn());
const getDownloadUrlMock = vi.hoisted(() => vi.fn());
const deleteMock = vi.hoisted(() => vi.fn());

vi.mock("../src/core/db/prisma.js", () => ({
  prisma: prismaMock,
}));

vi.mock("../src/core/storage/storageResolver.js", () => ({
  resolveStorageAdapter: vi.fn().mockResolvedValue({
    adapter: {
      backendId: "r2",
      upload: uploadMock,
      getDownloadUrl: getDownloadUrlMock,
      delete: deleteMock,
      ownsKey: vi.fn().mockReturnValue(true),
    },
  }),
  StorageConfigError: class StorageConfigError extends Error {},
}));

import { app } from "../src/app.js";

function authHeader(): string {
  return `Bearer ${signToken({
    userId: "user-1",
    email: "user@test.com",
    role: "admin",
    organizationId: "org-1",
    programDomain: "financial-hub",
  })}`;
}

function defaultDoc(id = "doc-1") {
  return {
    id,
    organizationId: "org-1",
    programDomain: "financial-hub",
    folder: "general",
    originalFilename: "invoice.pdf",
    safeFilename: "invoice.pdf",
    mimeType: "application/pdf",
    fileSize: 100,
    r2Key: "finance-hub/documents/general/1-invoice.pdf",
    storageProvider: "r2",
    uploadedByUserId: "user-1",
    status: "uploaded",
    deletedAt: null,
    deletedByUserId: null,
    createdAt: new Date("2026-05-10T00:00:00.000Z"),
    updatedAt: new Date("2026-05-10T00:00:00.000Z"),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  prismaMock.organizationProgramSubscription.findUnique.mockResolvedValue({ status: "active" });
  prismaMock.financeHubDocument.findMany.mockResolvedValue([defaultDoc()]);
  prismaMock.financeHubDocument.findFirst.mockResolvedValue(defaultDoc());
  prismaMock.financeHubDocument.create.mockResolvedValue(defaultDoc());
  prismaMock.financeHubDocument.update.mockResolvedValue({ ...defaultDoc(), status: "deleted", deletedAt: new Date() });
  uploadMock.mockResolvedValue({ key: "finance-hub/documents/general/1-invoice.pdf", fileUrl: "finance-hub/documents/general/1-invoice.pdf" });
  getDownloadUrlMock.mockResolvedValue("https://signed.example.com/file");
  deleteMock.mockResolvedValue(true);
});

describe("Finance Hub documents", () => {
  it("stores upload in requested folder partition", async () => {
    const response = await request(app)
      .post("/api/finance-hub/documents/upload")
      .set("Authorization", authHeader())
      .set("x-app-partition", "financial-hub")
      .field("folder", "test")
      .attach("file", Buffer.from("a,b,c"), { filename: "report.csv", contentType: "text/csv" });

    expect(response.status).toBe(201);
    expect(uploadMock).toHaveBeenCalled();
    expect(String(uploadMock.mock.calls[0][0])).toContain("finance-hub/documents/test/");
    expect(prismaMock.financeHubDocument.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          folder: "test",
          organizationId: "org-1",
        }),
      }),
    );
  });

  it("defaults folder to general when omitted", async () => {
    const response = await request(app)
      .post("/api/finance-hub/documents/upload")
      .set("Authorization", authHeader())
      .set("x-app-partition", "financial-hub")
      .attach("file", Buffer.from("pdf"), { filename: "invoice.pdf", contentType: "application/pdf" });

    expect(response.status).toBe(201);
    expect(String(uploadMock.mock.calls[0][0])).toContain("finance-hub/documents/general/");
    expect(prismaMock.financeHubDocument.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ folder: "general" }),
      }),
    );
  });

  it("filters list by folder and organization", async () => {
    const response = await request(app)
      .get("/api/finance-hub/documents?folder=test")
      .set("Authorization", authHeader())
      .set("x-app-partition", "financial-hub");

    expect(response.status).toBe(200);
    expect(prismaMock.financeHubDocument.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          organizationId: "org-1",
          folder: "test",
        }),
      }),
    );
  });

  it("returns signed URL for authorized document", async () => {
    const response = await request(app)
      .get("/api/finance-hub/documents/doc-1/url")
      .set("Authorization", authHeader())
      .set("x-app-partition", "financial-hub");

    expect(response.status).toBe(200);
    expect(response.body.url).toContain("https://signed.example.com");
  });

  it("soft deletes DB row and hard deletes R2 object", async () => {
    const response = await request(app)
      .delete("/api/finance-hub/documents/doc-1")
      .set("Authorization", authHeader())
      .set("x-app-partition", "financial-hub");

    expect(response.status).toBe(200);
    expect(deleteMock).toHaveBeenCalledWith("finance-hub/documents/general/1-invoice.pdf");
    expect(prismaMock.financeHubDocument.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: "deleted",
          deletedByUserId: "user-1",
        }),
      }),
    );
  });

  it("rejects unsupported mime type", async () => {
    const response = await request(app)
      .post("/api/finance-hub/documents/upload")
      .set("Authorization", authHeader())
      .set("x-app-partition", "financial-hub")
      .attach("file", Buffer.from("evil"), {
        filename: "payload.exe",
        contentType: "application/x-msdownload",
      });

    expect(response.status).toBe(415);
  });
});
