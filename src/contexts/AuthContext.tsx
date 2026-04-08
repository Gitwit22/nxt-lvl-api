import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import type { ReactNode } from "react";
import type { AuthContextValue, AuthUser } from "@/types/auth";
import { apiLogin, apiFetchCurrentUser } from "@/services/apiAuth";
import {
  clearStoredToken,
  getStoredToken,
  setStoredToken,
} from "@/lib/tokenStorage";

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  // On mount: try to restore session from localStorage and validate with /me
  useEffect(() => {
    const stored = getStoredToken();
    if (!stored) {
      setIsLoading(false);
      return;
    }
    apiFetchCurrentUser(stored)
      .then(({ user: freshUser }) => {
        setUser(freshUser);
        setToken(stored);
      })
      .catch(() => {
        // Token invalid or expired — clear it
        clearStoredToken();
      })
      .finally(() => {
        setIsLoading(false);
      });
  }, []);

  const login = useCallback(async (email: string, password: string) => {
    const { token: newToken, user: newUser } = await apiLogin({ email, password });
    setStoredToken(newToken);
    setToken(newToken);
    setUser(newUser);
  }, []);

  const logout = useCallback(() => {
    clearStoredToken();
    setToken(null);
    setUser(null);
    // Hard-navigate to /login so React Router state is fully reset
    window.location.href = "/login";
  }, []);

  /**
   * Initialized = logged-in user with valid tenant context.
   * An account missing organizationId/programDomain means the org setup
   * hasn't been completed (or token predates the tenant migration).
   */
  const isInitialized = useMemo(
    () => !!user && !!user.organizationId && !!user.programDomain,
    [user]
  );

  const value = useMemo<AuthContextValue>(
    () => ({
      user,
      token,
      organizationId: user?.organizationId ?? null,
      programDomain: user?.programDomain ?? null,
      role: user?.role ?? null,
      isLoading,
      isInitialized,
      login,
      logout,
    }),
    [user, token, isLoading, isInitialized, login, logout]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

/** Hook: access auth context — throws if used outside <AuthProvider> */
export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used inside <AuthProvider>");
  return ctx;
}
