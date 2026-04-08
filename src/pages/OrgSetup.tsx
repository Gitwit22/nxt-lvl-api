import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { Shield, Building2, AlertCircle, CheckCircle2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { PROGRAM_DISPLAY_NAME, PROGRAM_SYSTEM_NAME } from "@/lib/programInfo";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { useAuth } from "@/context/AuthContext";

interface SetupForm {
  organizationName: string;
  isSubmitting: boolean;
  errorMessage?: string;
  success: boolean;
}

const INITIAL: SetupForm = {
  organizationName: "",
  isSubmitting: false,
  errorMessage: undefined,
  success: false,
};

/**
 * OrgSetup — shown when the app has no organization configured yet, or when
 * the authenticated user has no org assignment.
 *
 * This screen lets the first admin create the organization record that scopes
 * all activity in Community Chronicle. Once submitted, it calls refreshSession()
 * so AuthContext re-resolves the appInitState and ProtectedRoute can route
 * the user forward.
 */
export default function OrgSetup() {
  const navigate = useNavigate();
  const { user, token, refreshSession, logout } = useAuth();
  const [form, setForm] = useState<SetupForm>(INITIAL);

  const BASE_URL = (import.meta.env.VITE_API_URL as string | undefined) ?? "";

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const name = form.organizationName.trim();
    if (!name) {
      setForm((p) => ({ ...p, errorMessage: "Organization name is required." }));
      return;
    }

    setForm((p) => ({ ...p, isSubmitting: true, errorMessage: undefined }));

    try {
      const res = await fetch(`${BASE_URL}/api/org/setup`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({ organizationName: name, programDomain: PROGRAM_SYSTEM_NAME }),
      });

      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        setForm((p) => ({
          ...p,
          isSubmitting: false,
          errorMessage: data.error ?? "Setup failed. Please try again.",
        }));
        return;
      }

      setForm((p) => ({ ...p, isSubmitting: false, success: true }));

      // Re-validate session so appInitState becomes "ready"
      await refreshSession();
      navigate("/", { replace: true });
    } catch {
      setForm((p) => ({
        ...p,
        isSubmitting: false,
        errorMessage: "Unable to reach the server. Please try again.",
      }));
    }
  };

  const handleLogout = () => {
    logout();
    navigate("/login", { replace: true });
  };

  return (
    <div className="min-h-screen bg-background flex flex-col">
      {/* Nav */}
      <header className="border-b border-border bg-card/60 backdrop-blur-sm">
        <div className="container max-w-6xl py-4 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-lg bg-primary flex items-center justify-center">
              <Shield className="h-5 w-5 text-primary-foreground" />
            </div>
            <div>
              <h1 className="font-display text-xl font-bold text-foreground leading-tight">
                {PROGRAM_DISPLAY_NAME}
              </h1>
              <p className="text-xs text-muted-foreground font-body">
                Organization Setup
              </p>
            </div>
          </div>
          {user && (
            <button
              onClick={handleLogout}
              className="text-xs text-muted-foreground font-body hover:text-foreground transition-colors"
            >
              Sign out
            </button>
          )}
        </div>
      </header>

      {/* Setup form */}
      <main className="flex-1 flex items-center justify-center py-16 px-4">
        <div className="w-full max-w-md">
          <div className="text-center mb-8">
            <div className="w-16 h-16 rounded-2xl bg-primary/10 flex items-center justify-center mx-auto mb-4">
              <Building2 className="h-8 w-8 text-primary" />
            </div>
            <h2 className="font-display text-3xl font-bold text-foreground mb-2">
              Set Up Your Organization
            </h2>
            <p className="text-muted-foreground font-body text-sm max-w-sm mx-auto">
              Before you can use the archive, create your organization. This scopes all
              documents, users, and activity to your team.
            </p>
          </div>

          <Card className="border-border shadow-sm">
            <CardHeader className="pb-4">
              <CardTitle className="font-display text-lg">Organization Details</CardTitle>
              <CardDescription className="font-body text-sm">
                This is a one-time setup. The organization name will appear throughout the
                app and in reports.
              </CardDescription>
            </CardHeader>

            <CardContent>
              {form.success ? (
                <div className="flex flex-col items-center gap-3 py-4 text-center">
                  <CheckCircle2 className="h-10 w-10 text-green-500" />
                  <p className="font-body text-sm text-foreground font-medium">
                    Organization created — redirecting…
                  </p>
                </div>
              ) : (
                <form onSubmit={handleSubmit} noValidate className="space-y-5">
                  {form.errorMessage && (
                    <div className="flex items-start gap-2.5 rounded-lg bg-destructive/10 border border-destructive/20 px-4 py-3 text-sm text-destructive font-body">
                      <AlertCircle className="h-4 w-4 mt-0.5 shrink-0" />
                      <span>{form.errorMessage}</span>
                    </div>
                  )}

                  <div className="space-y-2">
                    <Label
                      htmlFor="orgName"
                      className="font-body text-sm font-medium"
                    >
                      Organization name
                    </Label>
                    <Input
                      id="orgName"
                      type="text"
                      placeholder="e.g. Community Equity Partners"
                      value={form.organizationName}
                      onChange={(e) =>
                        setForm((p) => ({
                          ...p,
                          organizationName: e.target.value,
                          errorMessage: undefined,
                        }))
                      }
                      disabled={form.isSubmitting}
                      className="font-body"
                      autoFocus
                      required
                    />
                  </div>

                  <Button
                    type="submit"
                    className="w-full font-body gap-2 bg-primary hover:bg-primary/90"
                    disabled={form.isSubmitting}
                  >
                    {form.isSubmitting ? (
                      <>
                        <div className="h-4 w-4 border-2 border-primary-foreground/40 border-t-primary-foreground rounded-full animate-spin" />
                        Creating…
                      </>
                    ) : (
                      <>
                        <Building2 className="h-4 w-4" />
                        Create Organization
                      </>
                    )}
                  </Button>
                </form>
              )}
            </CardContent>
          </Card>

          {user && (
            <p className="text-center text-xs text-muted-foreground font-body mt-5">
              Signed in as{" "}
              <span className="text-foreground font-medium">{user.email}</span>
            </p>
          )}
        </div>
      </main>

      <footer className="border-t border-border py-6">
        <div className="container max-w-6xl text-center">
          <p className="text-xs text-muted-foreground font-body">
            {PROGRAM_DISPLAY_NAME} — Preserving civil rights history for researchers,
            educators, and advocates.
          </p>
        </div>
      </footer>
    </div>
  );
}
