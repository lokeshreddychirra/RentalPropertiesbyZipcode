"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { TrendingUp } from "@/components/ui/icons";
import { Button } from "@/components/ui/button";
import { Alert, Card } from "@/components/ui/card";
import { Field, Input } from "@/components/ui/form";
import { api, errorMessage } from "@/lib/api";
import { useSession, useStatus } from "@/lib/store";

function LoginForm() {
  const router = useRouter();
  const params = useSearchParams();
  const { refresh, user } = useSession();
  const { data: status } = useStatus();
  const [mode, setMode] = React.useState<"login" | "register">(params.get("mode") === "register" ? "register" : "login");
  const [email, setEmail] = React.useState("");
  const [password, setPassword] = React.useState("");
  const [name, setName] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);

  // Only allow same-site relative redirects.
  const requested = params.get("next") ?? "/";
  const next = requested.startsWith("/") && !requested.startsWith("//") ? requested : "/";

  React.useEffect(() => {
    if (user) router.replace(next);
  }, [user, router, next]);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (mode === "login") await api.login(email, password);
      else await api.register(email, password, name);
      await refresh();
      router.replace(next);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex min-h-[calc(100vh-2rem)] items-center justify-center px-4 py-10">
      <Card className="w-full max-w-sm p-6">
        <Link href="/" className="mb-5 flex items-center gap-2.5">
          <span className="flex size-8 items-center justify-center rounded-lg bg-primary text-primary-foreground">
            <TrendingUp className="size-4" aria-hidden />
          </span>
          <span className="text-[15px] font-semibold tracking-tight">
            PropertyYield <span className="text-positive">AI</span>
          </span>
        </Link>
        <h1 className="text-lg font-semibold">{mode === "login" ? "Sign in" : "Create your account"}</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          {mode === "register" ? "Free accounts include one ZIP code search with full analysis of every listing." : "Sign in to search ZIP codes and save properties."}
        </p>

        <form onSubmit={submit} className="mt-5 space-y-4">
          {mode === "register" ? (
            <Field label="Name (optional)" htmlFor="name">
              <Input id="name" value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" maxLength={120} />
            </Field>
          ) : null}
          <Field label="Email" htmlFor="email">
            <Input id="email" type="email" required value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" />
          </Field>
          <Field label="Password" htmlFor="password" hint={mode === "register" ? "At least 8 characters" : undefined}>
            <Input id="password" type="password" required minLength={8} maxLength={128} value={password} onChange={(e) => setPassword(e.target.value)} autoComplete={mode === "login" ? "current-password" : "new-password"} />
          </Field>
          {error ? <Alert tone="error">{error}</Alert> : null}
          <Button type="submit" className="w-full" disabled={busy}>
            {busy ? "Please wait…" : mode === "login" ? "Sign in" : "Create account"}
          </Button>
        </form>

        {status?.registration_enabled !== false ? (
          <p className="mt-4 text-center text-sm text-muted-foreground">
            {mode === "login" ? "New here?" : "Already have an account?"}{" "}
            <button
              type="button"
              className="font-medium text-foreground underline underline-offset-2"
              onClick={() => {
                setMode(mode === "login" ? "register" : "login");
                setError(null);
              }}
            >
              {mode === "login" ? "Create an account" : "Sign in"}
            </button>
          </p>
        ) : null}
        <p className="mt-3 text-center text-sm">
          <Link href="/" className="text-muted-foreground underline underline-offset-2">
            Continue without an account
          </Link>
        </p>
      </Card>
    </div>
  );
}

export default function LoginPage() {
  return (
    <React.Suspense fallback={null}>
      <LoginForm />
    </React.Suspense>
  );
}
