/**
 * Search Service
 *
 * Provides search and retrieval functionality for the document archive.
 * Includes relevance scoring, snippet extraction, faceted filtering,
 * and sort modes for scaled retrieval.
 */

import type { ArchiveDocument, DocumentFilters, PaginatedResult } from "@/types/document";
import { searchDocuments, searchDocumentsPaginated, getAllDocuments } from "./documentStore";

/** Sort options for search results */
export type SortField =
  | "relevance"
  | "date_desc"
  | "date_asc"
  | "title_asc"
  | "title_desc"
  | "year_desc"
  | "year_asc"
  | "status"
  | "category";

/** Search result with optional relevance score and snippet */
export interface SearchResult {
  document: ArchiveDocument;
  score: number;
  highlights?: { field: string; snippet: string }[];
  snippet?: string;
}

/**
 * Extract a matching snippet from text around the query match.
 */
export function extractSnippet(text: string, query: string, radius = 80): string {
  if (!text || !query) return text?.slice(0, 160) ?? "";
  const idx = text.toLowerCase().indexOf(query.toLowerCase());
  if (idx === -1) return text.slice(0, 160);
  const start = Math.max(0, idx - radius);
  const end = Math.min(text.length, idx + query.length + radius);
  let snippet = text.slice(start, end).trim();
  if (start > 0) snippet = "..." + snippet;
  if (end < text.length) snippet = snippet + "...";
  return snippet;
}

/**
 * Full-text search with relevance scoring.
 * Scores results across title, tags, category, metadata, extracted text, and recency.
 */
export function searchWithRelevance(
  query: string,
  filters?: Omit<DocumentFilters, "search">
): SearchResult[] {
  if (!query.trim()) {
    const docs = searchDocuments({ ...filters });
    return docs.map((doc) => ({ document: doc, score: 1.0 }));
  }

  const q = query.toLowerCase();
  const allFiltered = searchDocuments({ ...filters });

  const results: SearchResult[] = [];
  const now = Date.now();

  for (const doc of allFiltered) {
    let score = 0;
    const highlights: SearchResult["highlights"] = [];

    // Title match (highest weight) - exact title match vs partial
    if (doc.title.toLowerCase().includes(q)) {
      score += doc.title.toLowerCase() === q ? 60 : 50;
      highlights.push({ field: "title", snippet: doc.title });
    }

    // Category match
    if (doc.category.toLowerCase().includes(q)) {
      score += 20;
    }

    // Tag match
    const matchedTags = doc.tags.filter((t) => t.toLowerCase().includes(q));
    if (matchedTags.length > 0) {
      score += 25 * Math.min(matchedTags.length, 3);
      highlights.push({ field: "tags", snippet: matchedTags.join(", ") });
    }

    // Keyword match
    const matchedKeywords = doc.keywords.filter((k) => k.toLowerCase().includes(q));
    if (matchedKeywords.length > 0) {
      score += 5 * matchedKeywords.length;
      highlights.push({ field: "keywords", snippet: matchedKeywords.join(", ") });
    }

    // Author match
    if (doc.author.toLowerCase().includes(q)) {
      score += 6;
      highlights.push({ field: "author", snippet: doc.author });
    }

    // Description match
    if (doc.description.toLowerCase().includes(q)) {
      score += 3;
      highlights.push({
        field: "description",
        snippet: extractSnippet(doc.description, q, 40),
      });
    }

    // Extracted text match
    if (doc.extractedText.toLowerCase().includes(q)) {
      score += 15;
      highlights.push({
        field: "extractedText",
        snippet: extractSnippet(doc.extractedText, q, 50),
      });
    }

    // Metadata matches
    if (doc.extractedMetadata?.detectedOrganization?.toLowerCase().includes(q)) {
      score += 5;
    }
    if (doc.department?.toLowerCase().includes(q)) {
      score += 5;
    }

    // Only apply boosts if there was at least one content match
    if (score > 0) {
      // Recency boost: newer documents get a small boost
      const docAge = now - new Date(doc.createdAt).getTime();
      const dayAge = docAge / (1000 * 60 * 60 * 24);
      if (dayAge < 30) score += 5;
      else if (dayAge < 90) score += 3;
      else if (dayAge < 365) score += 1;

      // Status weighting: archived/processed docs rank slightly higher
      if (doc.processingStatus === "processed" || doc.status === "archived") {
        score += 2;
      }
      // Review/failed docs rank lower
      if (doc.processingStatus === "failed" || doc.status === "review_required") {
        score -= 1;
      }
    }

    if (score > 0) {
      const snippet = extractSnippet(doc.extractedText || doc.description, q);
      results.push({ document: doc, score, highlights, snippet });
    }
  }

  // Sort by score descending
  results.sort((a, b) => b.score - a.score);
  return results;
}

/**
 * Sort documents by the specified field.
 */
export function sortDocuments(docs: ArchiveDocument[], sortBy: SortField): ArchiveDocument[] {
  const sorted = [...docs];
  switch (sortBy) {
    case "date_desc":
      return sorted.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    case "date_asc":
      return sorted.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    case "title_asc":
      return sorted.sort((a, b) => a.title.localeCompare(b.title));
    case "title_desc":
      return sorted.sort((a, b) => b.title.localeCompare(a.title));
    case "year_desc":
      return sorted.sort((a, b) => b.year - a.year);
    case "year_asc":
      return sorted.sort((a, b) => a.year - b.year);
    case "status":
      return sorted.sort((a, b) =>
        (a.status ?? a.processingStatus).localeCompare(b.status ?? b.processingStatus)
      );
    case "category":
      return sorted.sort((a, b) => a.category.localeCompare(b.category));
    case "relevance":
    default:
      return sorted;
  }
}

/**
 * Paginated search with sorting.
 */
export function searchPaginated(
  filters: DocumentFilters,
  page = 1,
  pageSize = 20,
  sortBy: SortField = "relevance"
): PaginatedResult<ArchiveDocument> {
  let results: ArchiveDocument[];

  if (filters.search && sortBy === "relevance") {
    const scored = searchWithRelevance(filters.search, filters);
    results = scored.map((r) => r.document);
  } else {
    results = searchDocuments(filters);
    results = sortDocuments(results, sortBy);
  }

  const total = results.length;
  const totalPages = Math.ceil(total / pageSize);
  const start = (page - 1) * pageSize;
  const items = results.slice(start, start + pageSize);

  return { items, total, page, pageSize, totalPages };
}

/**
 * Get faceted counts for filter dropdowns.
 * Returns counts of documents for each value of each facet field.
 */
export function getFacetCounts(
  baseFilters?: DocumentFilters
): {
  categories: Record<string, number>;
  types: Record<string, number>;
  years: Record<string, number>;
  sources: Record<string, number>;
  statuses: Record<string, number>;
  lifecycleStatuses: Record<string, number>;
  reviewRequired: number;
  duplicateFlagged: number;
} {
  const docs = baseFilters ? searchDocuments(baseFilters) : getAllDocuments();

  const categories: Record<string, number> = {};
  const types: Record<string, number> = {};
  const years: Record<string, number> = {};
  const sources: Record<string, number> = {};
  const statuses: Record<string, number> = {};
  const lifecycleStatuses: Record<string, number> = {};
  let reviewRequired = 0;
  let duplicateFlagged = 0;

  for (const doc of docs) {
    categories[doc.category] = (categories[doc.category] || 0) + 1;
    types[doc.type] = (types[doc.type] || 0) + 1;
    years[String(doc.year)] = (years[String(doc.year)] || 0) + 1;
    sources[doc.intakeSource] = (sources[doc.intakeSource] || 0) + 1;
    statuses[doc.processingStatus] = (statuses[doc.processingStatus] || 0) + 1;
    if (doc.status) {
      lifecycleStatuses[doc.status] = (lifecycleStatuses[doc.status] || 0) + 1;
    }
    if (doc.review?.required && !doc.review?.resolution) {
      reviewRequired++;
    }
    if (doc.duplicateCheck?.duplicateStatus === "possible_duplicate") {
      duplicateFlagged++;
    }
  }

  return { categories, types, years, sources, statuses, lifecycleStatuses, reviewRequired, duplicateFlagged };
}

/**
 * Scaffold: Natural language query.
 */
export async function naturalLanguageQuery(
  _question: string
): Promise<{ answer: string; results: ArchiveDocument[] }> {
  throw new Error(
    "Natural language query is not yet implemented. Use searchWithRelevance() for keyword-based search."
  );
}
