import { useState } from "react";
import { useNavigate, Link } from "react-router-dom";
import { Shield, Eye, EyeOff, LogIn, AlertCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { useAuth } from "@/context/AuthContext";
import { PROGRAM_DISPLAY_NAME } from "@/lib/programInfo";
import type { LoginViewModel } from "@/auth/types";

const INITIAL_FORM: LoginViewModel = {
  email: "",
  password: "",
  isSubmitting: false,
  errorMessage: undefined,
};

export default function Login() {
  const navigate = useNavigate();
  const { login } = useAuth();
  const [form, setForm] = useState<LoginViewModel>(INITIAL_FORM);
  const [showPassword, setShowPassword] = useState(false);

  const handleChange = (field: "email" | "password", value: string) => {
    setForm((prev) => ({ ...prev, [field]: value, errorMessage: undefined }));
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!form.email.trim() || !form.password) {
      setForm((prev) => ({ ...prev, errorMessage: "Email and password are required." }));
      return;
    }

    setForm((prev) => ({ ...prev, isSubmitting: true, errorMessage: undefined }));

    const result = await login({ email: form.email.trim(), password: form.password });

    if (result.success) {
      // Route based on initialization state:
      //   not_initialized / no_org → setup screen
      //   ready                    → archive
      const dest =
        result.appInitState === "not_initialized" || result.appInitState === "no_org"
          ? "/setup"
          : "/";
      navigate(dest, { replace: true });
    } else {
      setForm((prev) => ({
        ...prev,
        isSubmitting: false,
        errorMessage: result.error.message,
      }));
    }
  };

  return (
    <div className="min-h-screen bg-background flex flex-col">
      {/* Nav */}
      <header className="border-b border-border bg-card/60 backdrop-blur-sm">
        <div className="container max-w-6xl py-4 flex items-center justify-between">
          <Link to="/landing" className="flex items-center gap-3 hover:opacity-80 transition-opacity">
            <div className="w-10 h-10 rounded-lg bg-primary flex items-center justify-center">
              <Shield className="h-5 w-5 text-primary-foreground" />
            </div>
            <div>
              <h1 className="font-display text-xl font-bold text-foreground leading-tight">
                {PROGRAM_DISPLAY_NAME}
              </h1>
              <p className="text-xs text-muted-foreground font-body">
                Civil Rights Document Archive
              </p>
            </div>
          </Link>
        </div>
      </header>

      {/* Login form */}
      <main className="flex-1 flex items-center justify-center py-16 px-4">
        <div className="w-full max-w-md">
          <div className="text-center mb-8">
            <div className="w-16 h-16 rounded-2xl bg-primary flex items-center justify-center mx-auto mb-4">
              <Shield className="h-8 w-8 text-primary-foreground" />
            </div>
            <h2 className="font-display text-3xl font-bold text-foreground mb-2">
              Sign In
            </h2>
            <p className="text-muted-foreground font-body text-sm">
              Access the {PROGRAM_DISPLAY_NAME} archive
            </p>
          </div>

          <Card className="border-border shadow-sm">
            <CardHeader className="pb-4">
              <CardTitle className="font-display text-lg">Account Login</CardTitle>
              <CardDescription className="font-body text-sm">
                Enter your credentials to continue. Contact your administrator if you
                need access.
              </CardDescription>
            </CardHeader>

            <CardContent>
              <form onSubmit={handleSubmit} noValidate className="space-y-5">
                {/* Error banner */}
                {form.errorMessage && (
                  <div className="flex items-start gap-2.5 rounded-lg bg-destructive/10 border border-destructive/20 px-4 py-3 text-sm text-destructive font-body">
                    <AlertCircle className="h-4 w-4 mt-0.5 shrink-0" />
                    <span>{form.errorMessage}</span>
                  </div>
                )}

                {/* Email */}
                <div className="space-y-2">
                  <Label htmlFor="email" className="font-body text-sm font-medium">
                    Email address
                  </Label>
                  <Input
                    id="email"
                    type="email"
                    autoComplete="email"
                    placeholder="you@example.com"
                    value={form.email}
                    onChange={(e) => handleChange("email", e.target.value)}
                    disabled={form.isSubmitting}
                    className="font-body"
                    required
                  />
                </div>

                {/* Password */}
                <div className="space-y-2">
                  <Label htmlFor="password" className="font-body text-sm font-medium">
                    Password
                  </Label>
                  <div className="relative">
                    <Input
                      id="password"
                      type={showPassword ? "text" : "password"}
                      autoComplete="current-password"
                      placeholder="••••••••"
                      value={form.password}
                      onChange={(e) => handleChange("password", e.target.value)}
                      disabled={form.isSubmitting}
                      className="font-body pr-10"
                      required
                    />
                    <button
                      type="button"
                      onClick={() => setShowPassword((v) => !v)}
                      className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground transition-colors"
                      aria-label={showPassword ? "Hide password" : "Show password"}
                    >
                      {showPassword ? (
                        <EyeOff className="h-4 w-4" />
                      ) : (
                        <Eye className="h-4 w-4" />
                      )}
                    </button>
                  </div>
                </div>

                {/* Submit */}
                <Button
                  type="submit"
                  className="w-full font-body gap-2 bg-primary hover:bg-primary/90"
                  disabled={form.isSubmitting}
                >
                  {form.isSubmitting ? (
                    <>
                      <div className="h-4 w-4 border-2 border-primary-foreground/40 border-t-primary-foreground rounded-full animate-spin" />
                      Signing in…
                    </>
                  ) : (
                    <>
                      <LogIn className="h-4 w-4" />
                      Sign In
                    </>
                  )}
                </Button>
              </form>
            </CardContent>
          </Card>

          <p className="text-center text-xs text-muted-foreground font-body mt-6">
            Don&apos;t have an account?{" "}
            <span className="text-foreground">
              Contact your archive administrator to request access.
            </span>
          </p>
        </div>
      </main>

      {/* Footer */}
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
