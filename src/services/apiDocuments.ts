import type { ArchiveDocument, DocumentFilters, DocumentIntakeInput, ReviewMetadata } from "@/types/document";
import { getAuthHeaders } from "@/lib/tokenStorage";

const API_BASE = import.meta.env.VITE_API_BASE_URL || "/api";

async function parseJsonResponse<T>(response: Response): Promise<T> {
  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    const message =
      payload && typeof payload === "object" && "error" in payload
        ? String((payload as Record<string, unknown>).error)
        : `Request failed with status ${response.status}`;
    throw new Error(message);
  }

  if (response.status === 204) {
    return undefined as T;
  }

  return (await response.json()) as T;
}

function buildQuery(filters: DocumentFilters): string {
  const params = new URLSearchParams();

  if (filters.search) params.set("search", filters.search);
  if (filters.year) params.set("year", filters.year);
  if (filters.category) params.set("category", filters.category);
  if (filters.processingStatus) params.set("processingStatus", filters.processingStatus);
  if (filters.intakeSource) params.set("intakeSource", filters.intakeSource);

  const query = params.toString();
  return query ? `?${query}` : "";
}

function appendOptionalMetadata(formData: FormData, metadata?: Partial<DocumentIntakeInput>) {
  if (!metadata) return;

  if (metadata.title) formData.set("title", metadata.title);
  if (metadata.description) formData.set("description", metadata.description);
  if (metadata.author) formData.set("author", metadata.author);
  if (metadata.year) formData.set("year", String(metadata.year));
  if (metadata.month) formData.set("month", String(metadata.month));
  if (metadata.category) formData.set("category", metadata.category);
  if (metadata.type) formData.set("type", metadata.type);
  if (metadata.financialCategory) formData.set("financialCategory", metadata.financialCategory);
  if (metadata.financialDocumentType)
    formData.set("financialDocumentType", metadata.financialDocumentType);
  if (metadata.department) formData.set("department", metadata.department);
  if (metadata.sourceReference) formData.set("sourceReference", metadata.sourceReference);
  if (metadata.intakeSource) formData.set("intakeSource", metadata.intakeSource);
  if (metadata.tags) formData.set("tags", JSON.stringify(metadata.tags));
  if (metadata.keywords) formData.set("keywords", JSON.stringify(metadata.keywords));
}

export async function apiGetAllDocuments(filters: DocumentFilters = {}): Promise<ArchiveDocument[]> {
  const response = await fetch(`${API_BASE}/documents${buildQuery(filters)}`, {
    headers: getAuthHeaders(),
  });
  return parseJsonResponse<ArchiveDocument[]>(response);
}

export async function apiGetDocumentById(id: string): Promise<ArchiveDocument | undefined> {
  const response = await fetch(`${API_BASE}/documents/${id}`, {
    headers: getAuthHeaders(),
  });
  if (response.status === 404) return undefined;
  return parseJsonResponse<ArchiveDocument>(response);
}

export async function apiUploadSingleFile(
  file: File,
  metadata?: Partial<DocumentIntakeInput>
): Promise<ArchiveDocument> {
  const formData = new FormData();
  formData.set("file", file);
  appendOptionalMetadata(formData, metadata);

  const response = await fetch(`${API_BASE}/documents/upload`, {
    method: "POST",
    headers: getAuthHeaders(),
    body: formData,
  });

  return parseJsonResponse<ArchiveDocument>(response);
}

export async function apiUploadMultipleFiles(
  files: File[],
  metadata?: Partial<DocumentIntakeInput>
): Promise<ArchiveDocument[]> {
  const formData = new FormData();
  files.forEach((file) => formData.append("files", file));
  appendOptionalMetadata(formData, metadata);

  const response = await fetch(`${API_BASE}/documents/upload/batch`, {
    method: "POST",
    headers: getAuthHeaders(),
    body: formData,
  });

  return parseJsonResponse<ArchiveDocument[]>(response);
}

export async function apiCreateManualEntry(
  input: Omit<DocumentIntakeInput, "intakeSource">
): Promise<ArchiveDocument> {
  const response = await fetch(`${API_BASE}/documents/manual`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...getAuthHeaders() },
    body: JSON.stringify(input),
  });

  return parseJsonResponse<ArchiveDocument>(response);
}

export async function apiUpdateDocument(
  id: string,
  updates: Partial<ArchiveDocument>
): Promise<ArchiveDocument> {
  const response = await fetch(`${API_BASE}/documents/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", ...getAuthHeaders() },
    body: JSON.stringify(updates),
  });

  return parseJsonResponse<ArchiveDocument>(response);
}

export async function apiDeleteDocument(id: string): Promise<boolean> {
  const response = await fetch(`${API_BASE}/documents/${id}`, {
    method: "DELETE",
    headers: getAuthHeaders(),
  });

  if (response.status === 404) return false;
  await parseJsonResponse<void>(response);
  return true;
}

export async function apiRetryProcessing(id: string): Promise<ArchiveDocument> {
  const response = await fetch(`${API_BASE}/documents/${id}/retry`, {
    method: "POST",
    headers: getAuthHeaders(),
  });

  return parseJsonResponse<ArchiveDocument>(response);
}

export async function apiGetReviewQueue(): Promise<ArchiveDocument[]> {
  const response = await fetch(`${API_BASE}/review-queue`, {
    headers: getAuthHeaders(),
  });
  return parseJsonResponse<ArchiveDocument[]>(response);
}

export async function apiResolveReview(
  docId: string,
  resolution: ReviewMetadata["resolution"],
  notes?: string
): Promise<ArchiveDocument> {
  const response = await fetch(`${API_BASE}/review-queue/${docId}/resolve`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...getAuthHeaders() },
    body: JSON.stringify({ resolution, notes }),
  });

  return parseJsonResponse<ArchiveDocument>(response);
}

export async function apiMarkForReview(
  docId: string,
  reasons: string[],
  priority: ReviewMetadata["priority"] = "medium"
): Promise<ArchiveDocument> {
  const response = await fetch(`${API_BASE}/review-queue/${docId}/mark`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...getAuthHeaders() },
    body: JSON.stringify({ reasons, priority }),
  });

  return parseJsonResponse<ArchiveDocument>(response);
}
