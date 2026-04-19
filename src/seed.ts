import { prisma } from "./core/db/prisma.js";
import { createDocumentPayload } from "./documentFactory.js";

export async function seedLegacyData(): Promise<void> {
  const existing = await prisma.document.count();
  if (existing > 0) return;

  const { mockDocuments } = await import("./data/documents.js");

  for (const doc of mockDocuments) {
    const payload = createDocumentPayload({
      title: doc.title,
      description: doc.description,
      author: doc.author,
      year: doc.year,
      category: doc.category,
      type: doc.type,
      keywords: doc.keywords,
      tags: doc.keywords,
      intakeSource: "legacy_import",
      extractedText: `${doc.title}\n\n${doc.description}\n\n${doc.aiSummary}`,
    });

    await prisma.document.create({
      data: {
        ...payload,
        id: doc.id,
        organizationId: "default-org",
        programDomain: "community-chronicle",
        fileUrl: doc.fileUrl,
        processingStatus: "processed",
        ocrStatus: "not_needed",
        createdAt: new Date(doc.createdAt),
        importedAt: new Date(doc.createdAt),
        status: "archived",
        statusUpdatedAt: new Date(doc.createdAt),
        needsReview: false,
        aiSummary: doc.aiSummary,
        extraction: {
          status: "complete",
          method: "manual",
          confidence: 1,
          extractedAt: doc.createdAt,
        },
        processingHistory: [
          {
            timestamp: doc.createdAt,
            action: "legacy_import",
            status: "processed",
            details: "Migrated from legacy data",
          },
        ],
      },
    });
  }
}
