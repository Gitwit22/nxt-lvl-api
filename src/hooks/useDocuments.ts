/**
 * React hooks for document operations.
 *
 * Uses TanStack React Query for cache management and state synchronization.
 * Wraps the service layer so components get reactive data.
 */

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import type { ArchiveDocument, DocumentFilters, DocumentIntakeInput } from "@/types/document";
import {
  getAllDocuments,
  getDocumentById,
  updateDocument,
  deleteDocument,
  getDocumentYears,
  getAllTags,
  getUsedCategories,
  getStatusCounts,
  searchDocuments,
} from "@/services/documentStore";
import {
  intakeSingleFile,
  intakeMultipleFiles,
  intakeDragDrop,
  intakeBulkFolder,
  intakeScannerImport,
  intakeManualEntry,
} from "@/services/intakeService";
import { retryProcessing } from "@/services/processingPipeline";

const QUERY_KEYS = {
  documents: ["documents"] as const,
  document: (id: string) => ["documents", id] as const,
  search: (filters: DocumentFilters) => ["documents", "search", filters] as const,
  years: ["documents", "years"] as const,
  tags: ["documents", "tags"] as const,
  categories: ["documents", "categories"] as const,
  statusCounts: ["documents", "statusCounts"] as const,
};

/** Hook: Get all documents */
export function useDocuments() {
  return useQuery({
    queryKey: QUERY_KEYS.documents,
    queryFn: getAllDocuments,
    staleTime: 1000,
  });
}

/** Hook: Get a single document by ID */
export function useDocument(id: string | undefined) {
  return useQuery({
    queryKey: QUERY_KEYS.document(id || ""),
    queryFn: () => (id ? getDocumentById(id) : undefined),
    enabled: !!id,
  });
}

/** Hook: Search and filter documents */
export function useDocumentSearch(filters: DocumentFilters) {
  return useQuery({
    queryKey: QUERY_KEYS.search(filters),
    queryFn: () => searchDocuments(filters),
    staleTime: 500,
  });
}

/** Hook: Get unique years */
export function useDocumentYears() {
  return useQuery({
    queryKey: QUERY_KEYS.years,
    queryFn: getDocumentYears,
  });
}

/** Hook: Get all tags */
export function useDocumentTags() {
  return useQuery({
    queryKey: QUERY_KEYS.tags,
    queryFn: getAllTags,
  });
}

/** Hook: Get used categories */
export function useDocumentCategories() {
  return useQuery({
    queryKey: QUERY_KEYS.categories,
    queryFn: getUsedCategories,
  });
}

/** Hook: Get status counts for dashboard */
export function useStatusCounts() {
  return useQuery({
    queryKey: QUERY_KEYS.statusCounts,
    queryFn: getStatusCounts,
  });
}

/** Hook: Upload single file */
export function useUploadFile() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ file, metadata }: { file: File; metadata?: Partial<DocumentIntakeInput> }) =>
      intakeSingleFile(file, metadata),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["documents"] });
    },
  });
}

/** Hook: Upload multiple files */
export function useUploadMultipleFiles() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ files, metadata }: { files: File[]; metadata?: Partial<DocumentIntakeInput> }) =>
      intakeMultipleFiles(files, metadata),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["documents"] });
    },
  });
}

/** Hook: Drag-and-drop upload */
export function useDragDropUpload() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ files, metadata }: { files: File[]; metadata?: Partial<DocumentIntakeInput> }) =>
      intakeDragDrop(files, metadata),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["documents"] });
    },
  });
}

/** Hook: Bulk folder upload */
export function useBulkUpload() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ files, metadata }: { files: File[]; metadata?: Partial<DocumentIntakeInput> }) =>
      intakeBulkFolder(files, metadata),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["documents"] });
    },
  });
}

/** Hook: Scanner import */
export function useScannerImport() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ files, metadata }: { files: File[]; metadata?: Partial<DocumentIntakeInput> }) =>
      intakeScannerImport(files, metadata),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["documents"] });
    },
  });
}

/** Hook: Manual document entry */
export function useManualEntry() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: Omit<DocumentIntakeInput, "intakeSource">) =>
      intakeManualEntry(input),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["documents"] });
    },
  });
}

/** Hook: Update a document */
export function useUpdateDocument() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, updates }: { id: string; updates: Partial<ArchiveDocument> }) =>
      updateDocument(id, updates),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["documents"] });
    },
  });
}

/** Hook: Delete a document */
export function useDeleteDocument() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => deleteDocument(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["documents"] });
    },
  });
}

/** Hook: Retry processing a failed document */
export function useRetryProcessing() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => retryProcessing(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["documents"] });
    },
  });
}
