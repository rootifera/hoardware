"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Check, Cpu, Loader2, Package, SlidersHorizontal } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";

export const SETUP_KEY = ["setup"];

/** Shows the first-run choice (standard PC hardware, or your own collection) until it has been made. */
export function SetupGate({ children }: { children: React.ReactNode }) {
  const setup = useQuery({ queryKey: SETUP_KEY, queryFn: api.setup, staleTime: 5 * 60_000, retry: 1 });
  if (setup.isPending) {
    return (
      <div className="flex min-h-screen items-center justify-center text-muted-foreground" role="status" aria-label="Loading">
        <Loader2 className="size-6 animate-spin" />
      </div>
    );
  }
  // If the answer cannot be read, do not block the app on it.
  if (setup.data && !setup.data.complete) return <FirstRun starterSets={setup.data.presets} />;
  return <>{children}</>;
}

function FirstRun({ starterSets }: { starterSets: { key: string; name: string; description: string; code_prefix: string; categories: string[] }[] }) {
  const queryClient = useQueryClient();
  const [step, setStep] = useState<"choose" | "custom">("choose");
  const custom = starterSets.filter((s) => s.key !== "pc");
  const [preset, setPreset] = useState(custom.find((s) => s.key === "blank")?.key ?? custom[0]?.key ?? "blank");
  const [title, setTitle] = useState("");
  const [prefix, setPrefix] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const chosen = custom.find((s) => s.key === preset);
  const effectivePrefix = (prefix ?? chosen?.code_prefix ?? "HW").toUpperCase();
  const prefixOk = /^[A-Z0-9]{1,6}$/.test(effectivePrefix);

  const run = useMutation({
    mutationFn: (mode: "standard" | "custom") =>
      api.runSetup(mode === "standard" ? { mode } : { mode, preset, title: title.trim() || undefined, code_prefix: effectivePrefix }),
    onSuccess: async () => {
      queryClient.removeQueries({ predicate: (q) => q.queryKey[0] !== SETUP_KEY[0] });
      await queryClient.invalidateQueries({ queryKey: SETUP_KEY });
    },
    onError: (e) => setError(e.message),
  });

  return (
    <main className="flex min-h-screen items-center justify-center px-4 py-10">
      <div className="w-full max-w-2xl space-y-6 rounded-xl border bg-card p-6 sm:p-8">
        <div className="flex items-center gap-2 text-lg font-semibold tracking-tight">
          <Cpu className="size-5" /> Hoardware
        </div>

        {step === "choose" && (
          <>
            <div>
              <h1 className="text-2xl font-semibold tracking-tight">What are you keeping track of?</h1>
              <p className="mt-1 text-sm text-muted-foreground">
                You can change everything later: categories, fields and names are all editable. This only decides where you start.
              </p>
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <button
                type="button"
                disabled={run.isPending}
                onClick={() => run.mutate("standard")}
                className="flex flex-col items-start gap-2 rounded-xl border p-4 text-left transition-colors hover:bg-muted/60 focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none"
              >
                <Cpu className="size-5" />
                <span className="font-medium">PC hardware (standard)</span>
                <span className="text-sm text-muted-foreground">
                  CPUs, graphics cards, motherboards, sound cards, RAM and storage, with ready-made fields and the CPU and graphics databases.
                </span>
                {run.isPending && run.variables === "standard" && <Loader2 className="size-4 animate-spin" />}
              </button>
              <button
                type="button"
                disabled={run.isPending}
                onClick={() => setStep("custom")}
                className="flex flex-col items-start gap-2 rounded-xl border p-4 text-left transition-colors hover:bg-muted/60 focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none"
              >
                <SlidersHorizontal className="size-5" />
                <span className="font-medium">Something else (customise)</span>
                <span className="text-sm text-muted-foreground">
                  Music gear, trading cards, electronics, or anything else. Start from a ready-made set or from an empty list and build your own categories.
                </span>
              </button>
            </div>
            {error && (
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
            )}
          </>
        )}

        {step === "custom" && (
          <>
            <div>
              <button type="button" className="mb-2 inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground" onClick={() => setStep("choose")}>
                <ArrowLeft className="size-3.5" /> Back
              </button>
              <h1 className="text-2xl font-semibold tracking-tight">Pick a starting point</h1>
              <p className="mt-1 text-sm text-muted-foreground">Categories, fields and predefined values to begin with. Add, rename or remove any of it afterwards.</p>
            </div>
            <div role="radiogroup" aria-label="Starter set" className="grid gap-2">
              {custom.map((s) => (
                <label
                  key={s.key}
                  className={cn("flex cursor-pointer items-start gap-3 rounded-xl border p-3 transition-colors hover:bg-muted/60", preset === s.key && "border-primary bg-muted/40")}
                >
                  <input type="radio" name="starter" className="mt-1 accent-primary" checked={preset === s.key} onChange={() => setPreset(s.key)} />
                  <span className="min-w-0">
                    <span className="flex items-center gap-2 font-medium">
                      <Package className="size-4" /> {s.name}
                    </span>
                    <span className="block text-sm text-muted-foreground">{s.description}</span>
                    {s.key !== "blank" && <span className="mt-1 block text-xs text-muted-foreground">{s.categories.join(" · ")}</span>}
                  </span>
                </label>
              ))}
            </div>
            <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_11rem]">
              <div className="grid gap-1.5">
                <Label htmlFor="setup-title">Name of your collection</Label>
                <Input id="setup-title" placeholder="Hoardware" maxLength={60} value={title} onChange={(e) => setTitle(e.target.value)} />
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="setup-prefix">Item code prefix</Label>
                <Input
                  id="setup-prefix"
                  maxLength={6}
                  aria-invalid={!prefixOk}
                  value={effectivePrefix}
                  onChange={(e) => setPrefix(e.target.value.toUpperCase())}
                />
                <p className="text-xs text-muted-foreground">Codes look like {prefixOk ? effectivePrefix : "…"}-000001. Letters and digits, up to 6.</p>
              </div>
            </div>
            {error && (
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
            )}
            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={() => setStep("choose")} disabled={run.isPending}>
                Back
              </Button>
              <Button onClick={() => run.mutate("custom")} disabled={run.isPending || !prefixOk}>
                {run.isPending ? <Loader2 className="animate-spin" /> : <Check />} Create my collection
              </Button>
            </div>
          </>
        )}
      </div>
    </main>
  );
}
