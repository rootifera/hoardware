"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Cpu, Loader2 } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { api, UNAUTHORIZED_EVENT } from "@/lib/api";

export const AUTH_KEY = ["auth-status"];

/** Shows the sign-in form instead of the app while login is on and there is no session. */
export function AuthGate({ children }: { children: React.ReactNode }) {
  const queryClient = useQueryClient();
  const status = useQuery({ queryKey: AUTH_KEY, queryFn: api.authStatus, staleTime: 60_000, retry: 1 });

  // Any API call answered with 401 means the session is gone.
  useEffect(() => {
    const onUnauthorized = () => queryClient.invalidateQueries({ queryKey: AUTH_KEY });
    window.addEventListener(UNAUTHORIZED_EVENT, onUnauthorized);
    return () => window.removeEventListener(UNAUTHORIZED_EVENT, onUnauthorized);
  }, [queryClient]);

  if (status.isPending) {
    return (
      <div className="flex min-h-screen items-center justify-center text-muted-foreground" role="status" aria-label="Loading">
        <Loader2 className="size-6 animate-spin" />
      </div>
    );
  }
  if (status.data?.auth_required && !status.data.authenticated) return <SignIn />;
  return <>{children}</>;
}

function SignIn() {
  const queryClient = useQueryClient();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.login(username, password);
      // Drop anything cached from before, then show the app.
      queryClient.removeQueries({ predicate: (q) => q.queryKey[0] !== AUTH_KEY[0] });
      await queryClient.invalidateQueries({ queryKey: AUTH_KEY });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not sign in");
      setBusy(false);
    }
  }

  return (
    <main className="flex min-h-screen items-center justify-center px-4">
      <form onSubmit={submit} className="w-full max-w-sm space-y-5 rounded-xl border bg-card p-6 sm:p-8">
        <div className="flex items-center gap-2 text-lg font-semibold tracking-tight">
          <Cpu className="size-5" /> Hoardware
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="login-user">Username</Label>
          <Input id="login-user" name="username" autoComplete="username" autoFocus value={username} onChange={(e) => setUsername(e.target.value)} />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="login-pass">Password</Label>
          <Input id="login-pass" name="password" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
        </div>
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        <Button type="submit" className="w-full" disabled={busy || !username || !password}>
          {busy && <Loader2 className="animate-spin" />} Sign in
        </Button>
      </form>
    </main>
  );
}
