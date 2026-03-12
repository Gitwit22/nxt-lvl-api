/**
 * Search Service
 *
 * Provides search and retrieval functionality for the document archive.
 * Currently implements client-side search with efficient filtering.
 *
 * Designed for future expansion to:
 * - Server-side full-text search (Elasticsearch, PostgreSQL FTS)
 * - Vector/semantic search (pgvector, Pinecone, Weaviate)
 * - Natural language querying via LLM
 */

import type { ArchiveDocument, DocumentFilters, PaginatedResult } from "@/types/document";
import { searchDocuments, searchDocumentsPaginated, getAllDocuments } from "./documentStore";

/** Sort options for search results */
export type SortField = "relevance" | "date_desc" | "date_asc" | "title_asc" | "title_desc" | "year_desc" | "year_asc";

/** Search result with optional relevance score */
export interface SearchResult {
  document: ArchiveDocument;
  score: number;
  highlights?: { field: string; snippet: string }[];
}

/**
 * Full-text search with relevance scoring.
 * Scores results based on where the match occurs (title > keywords > text).
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

  for (const doc of allFiltered) {
    let score = 0;
    const highlights: SearchResult["highlights"] = [];

    // Title match (highest weight)
    if (doc.title.toLowerCase().includes(q)) {
      score += 10;
      highlights.push({ field: "title", snippet: doc.title });
    }

    // Keyword match
    const matchedKeywords = doc.keywords.filter((k) => k.toLowerCase().includes(q));
    if (matchedKeywords.length > 0) {
      score += 5 * matchedKeywords.length;
      highlights.push({ field: "keywords", snippet: matchedKeywords.join(", ") });
    }

    // Tag match
    const matchedTags = doc.tags.filter((t) => t.toLowerCase().includes(q));
    if (matchedTags.length > 0) {
      score += 4 * matchedTags.length;
    }

    // Author match
    if (doc.author.toLowerCase().includes(q)) {
      score += 6;
      highlights.push({ field: "author", snippet: doc.author });
    }

    // Description match
    if (doc.description.toLowerCase().includes(q)) {
      score += 3;
      const idx = doc.description.toLowerCase().indexOf(q);
      const start = Math.max(0, idx - 40);
      const end = Math.min(doc.description.length, idx + q.length + 40);
      highlights.push({
        field: "description",
        snippet: (start > 0 ? "..." : "") + doc.description.slice(start, end) + (end < doc.description.length ? "..." : ""),
      });
    }

    // Extracted text match (lowest weight)
    if (doc.extractedText.toLowerCase().includes(q)) {
      score += 2;
      const idx = doc.extractedText.toLowerCase().indexOf(q);
      const start = Math.max(0, idx - 50);
      const end = Math.min(doc.extractedText.length, idx + q.length + 50);
      highlights.push({
        field: "extractedText",
        snippet: (start > 0 ? "..." : "") + doc.extractedText.slice(start, end) + (end < doc.extractedText.length ? "..." : ""),
      });
    }

    // Category match
    if (doc.category.toLowerCase().includes(q)) {
      score += 3;
    }

    if (score > 0) {
      results.push({ document: doc, score, highlights });
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
} {
  const docs = baseFilters ? searchDocuments(baseFilters) : getAllDocuments();

  const categories: Record<string, number> = {};
  const types: Record<string, number> = {};
  const years: Record<string, number> = {};
  const sources: Record<string, number> = {};
  const statuses: Record<string, number> = {};

  for (const doc of docs) {
    categories[doc.category] = (categories[doc.category] || 0) + 1;
    types[doc.type] = (types[doc.type] || 0) + 1;
    years[String(doc.year)] = (years[String(doc.year)] || 0) + 1;
    sources[doc.intakeSource] = (sources[doc.intakeSource] || 0) + 1;
    statuses[doc.processingStatus] = (statuses[doc.processingStatus] || 0) + 1;
  }

  return { categories, types, years, sources, statuses };
}

/**
 * Scaffold: Natural language query.
 *
 * When an LLM API is connected, this function will:
 * 1. Send the user's natural language question to the LLM
 * 2. The LLM generates structured search filters
 * 3. Execute the search with those filters
 * 4. Return results with an AI-generated answer
 *
 * For future vector search integration, extracted text can be
 * embedded and stored in a vector database for semantic retrieval.
 */
export async function naturalLanguageQuery(
  _question: string
): Promise<{ answer: string; results: ArchiveDocument[] }> {
  // TODO: Integrate with LLM API for natural language search
  throw new Error(
    "Natural language query is not yet implemented. Use searchWithRelevance() for keyword-based search."
  );
}
