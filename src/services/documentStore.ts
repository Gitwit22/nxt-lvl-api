/**
 * Document Store Service
 *
 * Provides CRUD operations for ArchiveDocument records.
 * Uses localStorage for persistence in the browser.
 * Designed with a clean interface so it can be swapped for a real API/database later.
 */

import type { ArchiveDocument, DocumentFilters, PaginatedResult } from "@/types/document";
import { mockDocuments } from "@/data/documents";
import type { Document as LegacyDocument } from "@/data/documents";

const STORAGE_KEY = "community_chronicle_documents";

/** Convert a legacy mock document to the new ArchiveDocument format */
function migrateLegacyDocument(doc: LegacyDocument): ArchiveDocument {
  return {
    id: doc.id,
    title: doc.title,
    description: doc.description,
    author: doc.author,
    year: doc.year,
    category: doc.category as ArchiveDocument["category"],
    type: doc.type as ArchiveDocument["type"],
    tags: [...doc.keywords],
    keywords: [...doc.keywords],
    originalFileName: undefined,
    mimeType: undefined,
    fileSize: undefined,
    fileUrl: doc.fileUrl,
    processingStatus: "processed",
    ocrStatus: "not_needed",
    extractedText: `${doc.title}\n\n${doc.description}\n\n${doc.aiSummary}`,
    extractedMetadata: {
      detectedTitle: doc.title,
      detectedDate: doc.createdAt,
      detectedAuthor: doc.author,
    },
    intakeSource: "legacy_import",
    createdAt: doc.createdAt,
    updatedAt: doc.createdAt,
    importedAt: doc.createdAt,
    processingHistory: [
      {
        timestamp: doc.createdAt,
        action: "legacy_import",
        status: "processed",
        details: "Migrated from legacy data",
      },
    ],
    needsReview: false,
    aiSummary: doc.aiSummary,
  };
}

/** Load documents from localStorage, seeding with mock data if empty */
function loadDocuments(): ArchiveDocument[] {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored) {
      const parsed = JSON.parse(stored) as ArchiveDocument[];
      if (parsed.length > 0) return parsed;
    }
  } catch {
    // Corrupt data, will re-seed
  }
  // Seed with migrated legacy mock data
  const seeded = mockDocuments.map(migrateLegacyDocument);
  saveDocuments(seeded);
  return seeded;
}

/** Persist documents to localStorage */
function saveDocuments(docs: ArchiveDocument[]): void {
  try {
    // Strip transient fileRef before persisting
    const serializable = docs.map(({ fileRef, ...rest }) => rest);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(serializable));
  } catch {
    console.warn("Failed to persist documents to localStorage");
  }
}

// In-memory cache
let documentsCache: ArchiveDocument[] | null = null;

function getAll(): ArchiveDocument[] {
  if (!documentsCache) {
    documentsCache = loadDocuments();
  }
  return documentsCache;
}

function invalidateCache(): void {
  documentsCache = null;
}

// --- Public API ---

/** Get all documents */
export function getAllDocuments(): ArchiveDocument[] {
  return getAll();
}

/** Get a single document by ID */
export function getDocumentById(id: string): ArchiveDocument | undefined {
  return getAll().find((doc) => doc.id === id);
}

/** Add a new document to the store */
export function addDocument(doc: ArchiveDocument): ArchiveDocument {
  const docs = getAll();
  docs.push(doc);
  saveDocuments(docs);
  invalidateCache();
  return doc;
}

/** Add multiple documents at once (batch) */
export function addDocuments(newDocs: ArchiveDocument[]): ArchiveDocument[] {
  const docs = getAll();
  docs.push(...newDocs);
  saveDocuments(docs);
  invalidateCache();
  return newDocs;
}

/** Update an existing document */
export function updateDocument(
  id: string,
  updates: Partial<ArchiveDocument>
): ArchiveDocument | undefined {
  const docs = getAll();
  const index = docs.findIndex((d) => d.id === id);
  if (index === -1) return undefined;
  docs[index] = {
    ...docs[index],
    ...updates,
    updatedAt: new Date().toISOString(),
  };
  saveDocuments(docs);
  invalidateCache();
  return docs[index];
}

/** Delete a document by ID */
export function deleteDocument(id: string): boolean {
  const docs = getAll();
  const index = docs.findIndex((d) => d.id === id);
  if (index === -1) return false;
  docs.splice(index, 1);
  saveDocuments(docs);
  invalidateCache();
  return true;
}

/** Search and filter documents */
export function searchDocuments(filters: DocumentFilters): ArchiveDocument[] {
  let results = getAll();

  if (filters.search) {
    const q = filters.search.toLowerCase();
    results = results.filter(
      (doc) =>
        doc.title.toLowerCase().includes(q) ||
        doc.description.toLowerCase().includes(q) ||
        doc.extractedText.toLowerCase().includes(q) ||
        doc.keywords.some((k) => k.toLowerCase().includes(q)) ||
        doc.tags.some((t) => t.toLowerCase().includes(q)) ||
        doc.author.toLowerCase().includes(q)
    );
  }

  if (filters.year) {
    results = results.filter((doc) => doc.year === Number(filters.year));
  }

  if (filters.month) {
    results = results.filter((doc) => doc.month === Number(filters.month));
  }

  if (filters.category) {
    results = results.filter((doc) => doc.category === filters.category);
  }

  if (filters.type) {
    results = results.filter((doc) => doc.type === filters.type);
  }

  if (filters.financialCategory) {
    results = results.filter((doc) => doc.financialCategory === filters.financialCategory);
  }

  if (filters.financialDocumentType) {
    results = results.filter((doc) => doc.financialDocumentType === filters.financialDocumentType);
  }

  if (filters.intakeSource) {
    results = results.filter((doc) => doc.intakeSource === filters.intakeSource);
  }

  if (filters.processingStatus) {
    results = results.filter((doc) => doc.processingStatus === filters.processingStatus);
  }

  if (filters.tags && filters.tags.length > 0) {
    results = results.filter((doc) =>
      filters.tags!.some((tag) => doc.tags.includes(tag))
    );
  }

  if (filters.dateFrom) {
    results = results.filter((doc) => doc.createdAt >= filters.dateFrom!);
  }

  if (filters.dateTo) {
    results = results.filter((doc) => doc.createdAt <= filters.dateTo!);
  }

  return results;
}

/** Paginated search */
export function searchDocumentsPaginated(
  filters: DocumentFilters,
  page = 1,
  pageSize = 20
): PaginatedResult<ArchiveDocument> {
  const all = searchDocuments(filters);
  const total = all.length;
  const totalPages = Math.ceil(total / pageSize);
  const start = (page - 1) * pageSize;
  const items = all.slice(start, start + pageSize);

  return { items, total, page, pageSize, totalPages };
}

/** Get all unique years from documents */
export function getDocumentYears(): number[] {
  return [...new Set(getAll().map((d) => d.year))].sort((a, b) => b - a);
}

/** Get all unique tags from documents */
export function getAllTags(): string[] {
  const tagSet = new Set<string>();
  getAll().forEach((doc) => doc.tags.forEach((t) => tagSet.add(t)));
  return [...tagSet].sort();
}

/** Get all unique categories from documents */
export function getUsedCategories(): string[] {
  return [...new Set(getAll().map((d) => d.category))].sort();
}

/** Get documents by processing status */
export function getDocumentsByStatus(status: ArchiveDocument["processingStatus"]): ArchiveDocument[] {
  return getAll().filter((doc) => doc.processingStatus === status);
}

/** Get document count by status for dashboard stats */
export function getStatusCounts(): Record<string, number> {
  const counts: Record<string, number> = {};
  getAll().forEach((doc) => {
    counts[doc.processingStatus] = (counts[doc.processingStatus] || 0) + 1;
  });
  return counts;
}

/** Reset the store (for testing) */
export function resetStore(): void {
  localStorage.removeItem(STORAGE_KEY);
  invalidateCache();
}
