import { Prisma } from "@prisma/client";
import { prisma } from "../../../core/db/prisma.js";

export async function createAttendeeImportBatch(input: {
  organizationId: string;
  eventId: string;
  fileName: string;
  fileType: "csv" | "xlsx";
  createdByUserId: string;
  totalRows: number;
  mappingConfig: Record<string, unknown>;
}) {
  return prisma.eventureImportBatch.create({
    data: {
      organizationId: input.organizationId,
      eventId: input.eventId,
      fileName: input.fileName,
      fileType: input.fileType,
      fileUrl: "inline-upload",
      sourceType: "attendee_list",
      status: "previewing",
      totalRows: input.totalRows,
      mappingConfig: input.mappingConfig as Prisma.InputJsonValue,
      createdByUserId: input.createdByUserId,
    },
  });
}

export async function createAttendeeImportRow(input: {
  organizationId: string;
  eventId: string;
  importBatchId: string;
  rowNumber: number;
  rawData: Record<string, unknown>;
  normalizedData: Record<string, unknown>;
  status: string;
  errorMessage?: string;
  detectedEmail?: string;
  detectedPhone?: string;
  detectedRegistrationType?: string;
}) {
  return prisma.eventureImportRow.create({
    data: {
      organizationId: input.organizationId,
      eventId: input.eventId,
      importBatchId: input.importBatchId,
      rowNumber: input.rowNumber,
      rawData: input.rawData as Prisma.InputJsonValue,
      normalizedData: input.normalizedData as Prisma.InputJsonValue,
      status: input.status,
      errorMessage: input.errorMessage,
      detectedEmail: input.detectedEmail,
      detectedPhone: input.detectedPhone,
      detectedRegistrationType: input.detectedRegistrationType,
    },
  });
}

export async function listAttendeeImportBatches(organizationId: string, eventId: string) {
  return prisma.eventureImportBatch.findMany({
    where: {
      organizationId,
      eventId,
      sourceType: "attendee_list",
    },
    orderBy: { createdAt: "desc" },
  });
}
