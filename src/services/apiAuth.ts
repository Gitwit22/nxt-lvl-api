import type {
  LoginCredentials,
  LoginResponse,
  MeResponse,
  RegisterPayload,
  RegisterResponse,
} from "@/types/auth";

const API_BASE = import.meta.env.VITE_API_BASE_URL || "/api";

async function parseAuthResponse<T>(res: Response): Promise<T> {
  const payload = await res.json().catch(() => ({})) as Record<string, unknown>;
  if (!res.ok) {
    const message =
      typeof payload.error === "string"
        ? payload.error
        : `Request failed with status ${res.status}`;
    throw new Error(message);
  }
  return payload as T;
}

/** POST /api/auth/login — returns token + tenant-aware user */
export async function apiLogin(credentials: LoginCredentials): Promise<LoginResponse> {
  const res = await fetch(`${API_BASE}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(credentials),
  });
  return parseAuthResponse<LoginResponse>(res);
}

/** GET /api/auth/me — validates existing token against backend, returns fresh user */
export async function apiFetchCurrentUser(token: string): Promise<MeResponse> {
  const res = await fetch(`${API_BASE}/auth/me`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  return parseAuthResponse<MeResponse>(res);
}

/** POST /api/auth/register — first user self-registers; subsequent require admin token */
export async function apiRegister(
  payload: RegisterPayload,
  token?: string
): Promise<RegisterResponse> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`${API_BASE}/auth/register`, {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
  });
  return parseAuthResponse<RegisterResponse>(res);
}
