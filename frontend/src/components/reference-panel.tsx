"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { BadgeCheck, Check, Link2, Search, Unlink } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { useDebouncedValue } from "@/hooks/use-debounced-value";
import { api } from "@/lib/api";
import type { ItemDetail, MatchType, ReferenceCandidate, ReferenceDetail, ReferenceSummary } from "@/lib/types";
import { cn } from "@/lib/utils";

const MATCH_LABEL: Record<MatchType, string> = {
  exact: "Exact part number",
  token: "Shares a code",
  text: "Name match only",
};

const MATCH_STYLE: Record<MatchType, string> = {
  exact: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300",
  token: "bg-sky-500/15 text-sky-700 dark:text-sky-300",
  text: "bg-muted text-muted-foreground",
};

function titleOf(r: ReferenceSummary): string {
  return [r.manufacturer, r.family, r.model].filter(Boolean).join(" · ");
}

function show(value: unknown): string {
  if (value === null) return "n/a";
  if (typeof value === "string") return value;
  return JSON.stringify(value);
}

function Highlights({ values }: { values: Record<string, unknown> }) {
  const entries = Object.entries(values);
  if (entries.length === 0) return null;
  return (
    <p className="truncate text-xs text-muted-foreground">
      {entries.map(([k, v]) => `${k.replace(/\(.*\)/, "").trim()}: ${show(v)}`).join(" · ")}
    </p>
  );
}

function CandidateRow({
  summary,
  match,
  disabled,
  busy,
  onLink,
}: {
  summary: ReferenceSummary;
  match?: ReferenceCandidate;
  disabled: boolean;
  busy: boolean;
  onLink: (confidence: "candidate" | "confirmed") => void;
}) {
  return (
    <li className="flex flex-wrap items-center gap-3 border-b py-2.5 last:border-0">
      <div className="min-w-0 flex-1 space-y-0.5">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-medium">{titleOf(summary)}</span>
          {match && (
            <Badge variant="secondary" className={cn("border-0", MATCH_STYLE[match.match_type])}>
              {MATCH_LABEL[match.match_type]}
              {match.match_type === "token" && match.matched_on.length > 0 && `: ${match.matched_on.join(", ")}`}
            </Badge>
          )}
          {match?.manufacturer_matches === false && (
            <Badge variant="outline" className="text-amber-700 dark:text-amber-300">
              different manufacturer
            </Badge>
          )}
        </div>
        <Highlights values={summary.highlights} />
      </div>
      <div className="flex gap-2">
        <Button size="sm" disabled={disabled || busy} onClick={() => onLink("confirmed")}>
          <Check /> Confirm match
        </Button>
        <Button size="sm" variant="outline" disabled={disabled || busy} onClick={() => onLink("candidate")}>
          Mark as candidate
        </Button>
      </div>
    </li>
  );
}

function Finder({ item, locked, onLink, busy }: { item: ItemDetail; locked: boolean; onLink: (id: number, c: "candidate" | "confirmed") => void; busy: boolean }) {
  const [query, setQuery] = useState("");
  const debounced = useDebouncedValue(query, 250);
  const candidates = useQuery({
    queryKey: ["reference-candidates", item.id, item.part_number, item.model, item.manufacturer],
    queryFn: () => api.referenceCandidates(item.id),
  });
  const search = useQuery({
    queryKey: ["reference-search", debounced],
    queryFn: () => api.searchReference(debounced),
    enabled: debounced.trim().length >= 2,
  });

  return (
    <div className="space-y-4">
      <div className="space-y-1">
        <h3 className="text-sm font-medium">Suggested matches</h3>
        {candidates.isPending ? (
          <Skeleton className="h-16 w-full" />
        ) : candidates.isError ? (
          <p className="text-sm text-destructive">{candidates.error.message}</p>
        ) : candidates.data.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No suggestions yet. Suggestions use the part number (including codes such as an S-Spec) and the model name, so add those
            above, or search below.
          </p>
        ) : (
          <ul>
            {candidates.data.map((c) => (
              <CandidateRow key={c.reference.id} summary={c.reference} match={c} disabled={locked} busy={busy} onLink={(conf) => onLink(c.reference.id, conf)} />
            ))}
          </ul>
        )}
      </div>

      <div className="space-y-2">
        <h3 className="text-sm font-medium">Search all reference models</h3>
        <div className="relative">
          <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input className="pl-8" placeholder="e.g. Pentium MMX 200" value={query} onChange={(e) => setQuery(e.target.value)} />
        </div>
        {search.data && search.data.items.length === 0 && <p className="text-sm text-muted-foreground">Nothing found.</p>}
        {search.data && (
          <ul>
            {search.data.items.map((r) => (
              <CandidateRow key={r.id} summary={r} disabled={locked} busy={busy} onLink={(conf) => onLink(r.id, conf)} />
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

const COLLAPSED_SPECS = 14;

function LinkedReference({ item, reference, locked, onUnlink, onConfirm, onChange, onUseName, onRefill, busy }: { item: ItemDetail; reference: ReferenceDetail; locked: boolean; onUnlink: () => void; onConfirm: () => void; onChange: () => void; onUseName: () => void; onRefill: () => void; busy: boolean }) {
  const [all, setAll] = useState(false);
  const overrides = new Map(Object.entries(item.attributes).map(([k, v]) => [k.toLowerCase(), v]));
  const entries = Object.entries(reference.specs)
    .filter(([k]) => k !== "references")
    .sort(([a], [b]) => a.localeCompare(b));
  const visible = all ? entries : entries.slice(0, COLLAPSED_SPECS);
  const refs = Array.isArray(reference.specs.references) ? (reference.specs.references as string[]) : [];
  const confirmed = item.identification_confidence === "confirmed";
  const where = reference.provenance as { file?: string; line?: number };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 space-y-1">
          <p className="text-lg font-medium">{[reference.manufacturer, reference.display_name].filter(Boolean).join(" ")}</p>
          {reference.spec_line && <p className="text-sm text-muted-foreground">{reference.spec_line}</p>}
          <p className="font-mono text-xs text-muted-foreground">
            {reference.order_code ?? reference.part_number ?? reference.model}
            {reference.s_spec && <span className="ml-2 rounded bg-muted px-1.5 py-0.5 font-semibold text-foreground">S-Spec {reference.s_spec}</span>}
          </p>
          <div className="flex flex-wrap gap-1.5">
            <Badge variant="secondary">{reference.source.name}</Badge>
            <Badge variant="outline" className={confirmed ? "text-emerald-700 dark:text-emerald-300" : "text-muted-foreground"}>
              {confirmed ? <BadgeCheck className="size-3" /> : null}
              {confirmed ? "Match confirmed" : "Unconfirmed candidate"}
            </Badge>
            {reference.aliases.length > 0 && <Badge variant="outline">also: {reference.aliases.join(", ")}</Badge>}
          </div>
        </div>
        <div className="flex gap-2">
          {item.model !== reference.display_name && (
            <Button size="sm" variant="outline" disabled={locked || busy} title={`Rename this item to “${reference.display_name}”`} onClick={onUseName}>
              Use this name
            </Button>
          )}
          <Button size="sm" variant="outline" disabled={locked || busy} title="Copy any specs this item does not have yet; yours are never overwritten" onClick={onRefill}>
            Fill in missing specs
          </Button>
          {!confirmed && (
            <Button size="sm" disabled={locked || busy} onClick={onConfirm}>
              <Check /> Confirm
            </Button>
          )}
          <Button size="sm" variant="outline" disabled={locked || busy} onClick={onChange}>
            <Link2 /> Change
          </Button>
          <Button size="sm" variant="outline" disabled={locked || busy} onClick={onUnlink}>
            <Unlink /> Unlink
          </Button>
        </div>
      </div>

      <p className="text-sm text-muted-foreground">
        Its specs were copied onto this item: see <b>Specifications</b> above. They are yours to edit, and unlinking keeps them.
      </p>
      <details className="rounded-md border px-3 py-2">
        <summary className="cursor-pointer text-sm text-muted-foreground">The original record in the dataset</summary>
        <div className="mt-3 space-y-4">
        <dl className="grid gap-x-6 gap-y-2 sm:grid-cols-2">
          {visible.map(([key, value]) => {
            const override = overrides.get(key.toLowerCase());
            return (
              <div key={key} className="min-w-0 border-b border-border/50 pb-1.5">
                <dt className="text-xs text-muted-foreground">{key}</dt>
                <dd className="break-words text-sm">
                  <span className={cn(override !== undefined && "text-muted-foreground line-through")}>{show(value)}</span>
                  {override !== undefined && (
                    <span className="ml-2 font-medium">
                      {show(override)} <Badge variant="outline" className="ml-1 align-middle">your value</Badge>
                    </span>
                  )}
                </dd>
              </div>
            );
          })}
        </dl>
        {entries.length > COLLAPSED_SPECS && (
          <Button variant="ghost" size="sm" onClick={() => setAll(!all)}>
            {all ? "Show fewer" : `Show all ${entries.length} fields`}
          </Button>
        )}
        {entries.length === 0 && <p className="text-sm text-muted-foreground">This record has no published specifications.</p>}

        {refs.length > 0 && (
          <div className="space-y-1">
            <h3 className="text-sm font-medium">Sources cited</h3>
            <ul className="space-y-0.5 text-sm text-muted-foreground">
              {refs.map((r, i) => (
                <li key={i} className="break-words">
                  {/^https?:\/\//.test(r) ? (
                    <a className="underline" href={r} target="_blank" rel="noopener noreferrer">
                      {r}
                    </a>
                  ) : (
                    r
                  )}
                </li>
              ))}
            </ul>
          </div>
        )}

        <p className="text-xs text-muted-foreground">
          Imported specs from {reference.source.name} (snapshot {reference.source_version}, {new Date(reference.imported_at).toLocaleDateString()}
          {where.file ? `, ${where.file}${where.line ? ` line ${where.line}` : ""}` : ""}). {reference.source.licence ?? ""} They are shown for
          reference and never replace your own fields; values you enter under Specifications take precedence.
        </p>

        </div>
      </details>
    </div>
  );
}

export function ReferencePanel({ item, locked }: { item: ItemDetail; locked: boolean }) {
  const queryClient = useQueryClient();
  const [changing, setChanging] = useState(false);
  // Optional extra: when nothing is linked the panel stays a single quiet line
  // until the user asks for suggestions.
  const [finding, setFinding] = useState(false);
  const [confirmUnlink, setConfirmUnlink] = useState(false);
  const sources = useQuery({ queryKey: ["reference-sources"], queryFn: api.referenceSources, staleTime: 60_000 });

  const done = (updated: ItemDetail, message: string) => {
    queryClient.setQueryData(["item", item.id], updated);
    queryClient.invalidateQueries({ queryKey: ["items"] });
    queryClient.invalidateQueries({ queryKey: ["reference-candidates", item.id] });
    setChanging(false);
    setFinding(false);
    toast.success(message);
  };
  const link = useMutation({
    mutationFn: (v: { id: number; confidence: "candidate" | "confirmed" }) => api.linkReference(item.id, v.id, v.confidence),
    onSuccess: (u, v) => done(u, v.confidence === "confirmed" ? "Match confirmed" : "Saved as a candidate"),
    onError: (e) => toast.error(e.message),
  });
  const refill = useMutation({
    mutationFn: () => api.linkReference(item.id, item.reference!.id, item.identification_confidence === "candidate" ? "candidate" : "confirmed"),
    onSuccess: (updated) => {
      queryClient.setQueryData(["item", item.id], updated);
      queryClient.invalidateQueries({ queryKey: ["items"] });
      toast.success("Specs updated");
    },
    onError: (e) => toast.error(e.message),
  });
  const rename = useMutation({
    mutationFn: (name: string) => api.updateItem(item.id, { model: name }),
    onSuccess: (updated) => {
      queryClient.setQueryData(["item", item.id], updated);
      queryClient.invalidateQueries({ queryKey: ["items"] });
      toast.success("Name updated");
    },
    onError: (e) => toast.error(e.message),
  });
  const unlink = useMutation({
    mutationFn: () => api.unlinkReference(item.id),
    onSuccess: (u) => {
      setConfirmUnlink(false);
      done(u, "Match removed");
    },
    onError: (e) => toast.error(e.message),
  });

  const hasData = (sources.data ?? []).some((s) => s.models > 0);
  const reference = item.reference;

  return (
    <section className="space-y-3 rounded-xl border border-dashed p-5 sm:p-6">
      <h2 className="text-base font-semibold tracking-tight">Matched record</h2>
      {locked && (
        <p className="rounded-md bg-amber-500/10 px-3 py-2 text-sm text-amber-800 dark:text-amber-200">
          You have unsaved changes. Save or revert them before changing the match.
        </p>
      )}

      {sources.isSuccess && !hasData && !reference ? (
        <p className="text-sm text-muted-foreground">
          No reference datasets are imported, so there is nothing to match against. This is optional: everything else works without it. See
          “Reference data” in the README to import CPU-DB.
        </p>
      ) : reference && !changing ? (
        <LinkedReference
          item={item}
          reference={reference}
          locked={locked}
          busy={link.isPending || unlink.isPending || rename.isPending || refill.isPending}
          onRefill={() => refill.mutate()}
          onUseName={() => rename.mutate(reference.display_name)}
          onConfirm={() => link.mutate({ id: reference.id, confidence: "confirmed" })}
          onChange={() => setChanging(true)}
          onUnlink={() => setConfirmUnlink(true)}
        />
      ) : !reference && !finding ? (
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-sm text-muted-foreground">Not matched to a reference model (optional).</p>
          <Button variant="outline" size="sm" onClick={() => setFinding(true)}>
            <Search /> Find reference match
          </Button>
        </div>
      ) : (
        <>
          {!reference && (
            <div className="flex justify-end">
              <Button variant="ghost" size="sm" onClick={() => setFinding(false)}>
                Close
              </Button>
            </div>
          )}
          {reference && (
            <div className="flex items-center justify-between">
              <p className="text-sm text-muted-foreground">Currently linked to {titleOf(reference)}.</p>
              <Button variant="ghost" size="sm" onClick={() => setChanging(false)}>
                Cancel
              </Button>
            </div>
          )}
          <Finder item={item} locked={locked} busy={link.isPending} onLink={(id, confidence) => link.mutate({ id, confidence })} />
        </>
      )}

      <AlertDialog open={confirmUnlink} onOpenChange={setConfirmUnlink}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove this match?</AlertDialogTitle>
            <AlertDialogDescription>
              The item goes back to “unidentified”. Its own fields and any values you entered stay exactly as they are.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={() => unlink.mutate()}>
              Unlink
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}
