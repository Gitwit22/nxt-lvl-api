/** Key used to store the JWT in localStorage */
export const AUTH_TOKEN_KEY = "cc_auth_token";

/** Returns the stored auth token, or null */
export function getStoredToken(): string | null {
  try {
    return localStorage.getItem(AUTH_TOKEN_KEY);
  } catch {
    return null;
  }
}

/** Persists the auth token */
export function setStoredToken(token: string): void {
  localStorage.setItem(AUTH_TOKEN_KEY, token);
}

/** Clears the stored token */
export function clearStoredToken(): void {
  localStorage.removeItem(AUTH_TOKEN_KEY);
}

/** Returns Authorization header value if a token is stored, otherwise empty object */
export function getAuthHeaders(): Record<string, string> {
  const token = getStoredToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
}
