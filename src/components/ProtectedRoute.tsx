import { Navigate, useLocation } from "react-router-dom";
import type { ReactNode } from "react";
import { useAuth } from "@/contexts/AuthContext";

interface ProtectedRouteProps {
  children: ReactNode;
  /** Minimum role required. Defaults to any authenticated user. */
  requiredRole?: "uploader" | "reviewer" | "admin";
}

const ROLE_LEVEL: Record<string, number> = { uploader: 1, reviewer: 2, admin: 3 };

/**
 * Tenant-aware route guard.
 *
 * Decision tree:
 *  1. Still loading session  → render nothing (avoids flash)
 *  2. Not authenticated      → /login
 *  3. Authenticated but no tenant context (isInitialized = false) → /setup
 *  4. Wrong role             → /login (simple denial; could be a 403 page)
 *  5. All checks pass        → render children
 */
export default function ProtectedRoute({
  children,
  requiredRole,
}: ProtectedRouteProps) {
  const { isLoading, user, isInitialized, role } = useAuth();
  const location = useLocation();

  if (isLoading) {
    // Neutral loading state — prevents flash of redirect on refresh
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <div className="w-8 h-8 rounded-full border-2 border-primary border-t-transparent animate-spin" />
      </div>
    );
  }

  if (!user) {
    return <Navigate to="/login" state={{ from: location }} replace />;
  }

  if (!isInitialized) {
    return <Navigate to="/setup" replace />;
  }

  if (
    requiredRole &&
    (ROLE_LEVEL[role ?? ""] ?? 0) < (ROLE_LEVEL[requiredRole] ?? 0)
  ) {
    // Authenticated but insufficient role — go back to login for now
    return <Navigate to="/login" replace />;
  }

  return <>{children}</>;
}
