import { Shield, AlertCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/contexts/AuthContext";
import { PROGRAM_DISPLAY_NAME } from "@/lib/programInfo";

/**
 * Shown when a user is authenticated but their account is missing valid
 * tenant context (organizationId / programDomain).
 *
 * This typically means:
 *  - They registered before the tenant migration ran, OR
 *  - Their token predates the multi-tenant upgrade.
 *
 * Resolution: contact an admin to run the backfill script, or log out and
 * back in once org context has been assigned.
 */
export default function OrgSetupPage() {
  const { user, organizationId, programDomain, logout } = useAuth();

  return (
    <div className="min-h-screen bg-background flex items-center justify-center p-4">
      <div className="w-full max-w-md space-y-8">
        {/* Header */}
        <div className="flex flex-col items-center gap-3">
          <div className="w-12 h-12 rounded-xl bg-amber-500/10 flex items-center justify-center">
            <AlertCircle className="h-6 w-6 text-amber-500" />
          </div>
          <div className="text-center">
            <h1 className="font-display text-2xl font-bold text-foreground">
              Organization Not Configured
            </h1>
            <p className="text-sm text-muted-foreground font-body mt-1">
              Your account needs to be assigned to an organization before you
              can access Chronicle.
            </p>
          </div>
        </div>

        {/* Context info */}
        <div className="rounded-lg border border-border bg-card p-4 space-y-2 text-sm font-body">
          <div className="flex justify-between">
            <span className="text-muted-foreground">Signed in as</span>
            <span className="text-foreground font-medium">{user?.email}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-muted-foreground">Organization ID</span>
            <span className="text-foreground font-mono text-xs">
              {organizationId ?? <em className="text-muted-foreground">not set</em>}
            </span>
          </div>
          <div className="flex justify-between">
            <span className="text-muted-foreground">Program Domain</span>
            <span className="text-foreground font-mono text-xs">
              {programDomain ?? <em className="text-muted-foreground">not set</em>}
            </span>
          </div>
        </div>

        {/* Next steps */}
        <div className="rounded-lg border border-border bg-muted/40 p-4 text-sm font-body space-y-2">
          <p className="font-semibold text-foreground">What to do next</p>
          <ol className="list-decimal list-inside space-y-1 text-muted-foreground">
            <li>Ask your administrator to run the tenant backfill script.</li>
            <li>Once your account is updated, sign out and sign back in.</li>
            <li>Your tenant context will be included in the new token.</li>
          </ol>
        </div>

        <div className="flex gap-3">
          <Button
            variant="outline"
            className="flex-1 font-body"
            onClick={logout}
          >
            Sign out
          </Button>
          <Button
            className="flex-1 font-body"
            onClick={() => window.location.reload()}
          >
            Retry
          </Button>
        </div>

        <div className="flex items-center gap-2 justify-center text-xs text-muted-foreground font-body">
          <Shield className="h-3 w-3" />
          <span>{PROGRAM_DISPLAY_NAME} · Tenant-scoped access</span>
        </div>
      </div>
    </div>
  );
}
