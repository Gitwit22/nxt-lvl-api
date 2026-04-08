/**
 * Frontend auth types — tenant-aware user model matching backend token/me shape.
 */

export type UserRole = "uploader" | "reviewer" | "admin";

/** Full authenticated user, including tenant context */
export interface AuthUser {
  id: string;
  email: string;
  role: UserRole;
  displayName: string;
  organizationId: string;
  programDomain: string;
}

/** Response shape from POST /api/auth/login */
export interface LoginResponse {
  token: string;
  user: AuthUser;
}

/** Response shape from GET /api/auth/me */
export interface MeResponse {
  user: AuthUser;
}

/** Response shape from POST /api/auth/register */
export interface RegisterResponse {
  user: AuthUser;
}

/** Login credentials payload */
export interface LoginCredentials {
  email: string;
  password: string;
}

/** Register payload */
export interface RegisterPayload {
  email: string;
  password: string;
  displayName?: string;
  role?: UserRole;
}

/** Full shape of the AuthContext value */
export interface AuthContextValue {
  /** Authenticated user (null if not logged in) */
  user: AuthUser | null;
  /** Raw JWT token (null if not logged in) */
  token: string | null;
  /** Convenience: organizationId from user (null if not logged in) */
  organizationId: string | null;
  /** Convenience: programDomain from user (null if not logged in) */
  programDomain: string | null;
  /** Convenience: role from user (null if not logged in) */
  role: UserRole | null;
  /** True while validating existing session on mount */
  isLoading: boolean;
  /**
   * True once the user has a valid tenant context (organizationId + programDomain).
   * False means they're authenticated but the org setup hasn't completed.
   */
  isInitialized: boolean;
  /** Login with email + password. Throws on failure. */
  login: (email: string, password: string) => Promise<void>;
  /** Clear session and redirect to /login */
  logout: () => void;
}
