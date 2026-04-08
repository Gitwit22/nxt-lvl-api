import { Navigate } from "react-router-dom";
import type { ReactNode } from "react";
import { useAuth } from "@/context/AuthContext";
import { PROGRAM_SYSTEM_NAME } from "@/lib/programInfo";

const ROLE_LEVEL: Record<string, number> = {
  uploader: 1,
  reviewer: 2,
  admin: 3,
};

/**
 * Tenant-aware route guard.
 *
 * Decision tree:
 *  1. Still loading session                -> spinner
 *  2. Not authenticated                    -> /login
 *  3. Not initialized or missing org       -> /org-setup
 *  4. Missing/wrong program domain context -> /org-setup
 *  5. Role insufficient (if requiredRole)  -> /login
 *  6. Otherwise                            -> render children
 */
export function ProtectedRoute({
  children,
  requiredRole,
}: {
  children: ReactNode;
  requiredRole?: "uploader" | "reviewer" | "admin";
}) {
  const { user, appInitState, isLoading, role, programDomain } = useAuth();

  if (isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <div className="h-10 w-10 border-4 border-primary/30 border-t-primary rounded-full animate-spin" />
      </div>
    );
  }

  if (!user) {
    return <Navigate to="/login" replace />;
  }

  if (appInitState === "not_initialized" || appInitState === "no_org") {
    return <Navigate to="/org-setup" replace />;
  }

  if (!programDomain || programDomain !== PROGRAM_SYSTEM_NAME) {
    return <Navigate to="/org-setup" replace />;
  }

  if (
    requiredRole &&
    (ROLE_LEVEL[role ?? ""] ?? 0) < (ROLE_LEVEL[requiredRole] ?? 0)
  ) {
    return <Navigate to="/login" replace />;
  }

  return <>{children}</>;
}

export default ProtectedRoute;
