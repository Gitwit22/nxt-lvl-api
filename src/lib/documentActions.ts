const API_BASE = import.meta.env.VITE_API_BASE_URL || "/api";

function apiOrigin(): string | null {
  if (!API_BASE.startsWith("http://") && !API_BASE.startsWith("https://")) {
    return null;
  }

  try {
    const parsed = new URL(API_BASE);
    return `${parsed.protocol}//${parsed.host}`;
  } catch {
    return null;
  }
}

export function resolveDocumentUrl(fileUrl?: string): string | null {
  if (!fileUrl) return null;
  if (fileUrl.startsWith("http://") || fileUrl.startsWith("https://")) {
    return fileUrl;
  }

  if (fileUrl.startsWith("/")) {
    const origin = apiOrigin();
    return origin ? `${origin}${fileUrl}` : fileUrl;
  }

  return fileUrl;
}

export function downloadDocument(fileUrl?: string, filename?: string): boolean {
  const resolved = resolveDocumentUrl(fileUrl);
  if (!resolved) return false;

  const anchor = document.createElement("a");
  anchor.href = resolved;
  if (filename) {
    anchor.download = filename;
  }
  anchor.rel = "noopener noreferrer";
  anchor.target = "_blank";
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  return true;
}

export function openOriginalDocument(fileUrl?: string): boolean {
  const resolved = resolveDocumentUrl(fileUrl);
  if (!resolved) return false;

  window.open(resolved, "_blank", "noopener,noreferrer");
  return true;
}
