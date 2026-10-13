"use client";

import { useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, Download, FileUp, Loader2, TriangleAlert } from "lucide-react";
import Link from "next/link";
import { useRef, useState } from "react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api";
import type { ImportOptions, ImportReport } from "@/lib/types";

const DEFAULTS: Omit<ImportOptions, "commit"> = { skipInvalid: false, createCategories: false, createLocations: false };

export default function ImportPage() {
  const queryClient = useQueryClient();
  const input = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [options, setOptions] = useState(DEFAULTS);
  const [report, setReport] = useState<ImportReport | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run(f: File, o: typeof DEFAULTS, commit: boolean) {
    setBusy(true);
    setError(null);
    try {
      const result = await api.importItems(f, { ...o, commit });
      setReport(result);
      if (result.committed) {
        for (const key of ["items", "categories", "location-children", "location-picker", "manufacturers"]) {
          queryClient.invalidateQueries({ queryKey: [key] });
        }
        toast.success(`Imported ${result.imported.toLocaleString()} item${result.imported === 1 ? "" : "s"}`);
      }
    } catch (e) {
      setReport(null);
      setError(e instanceof Error ? e.message : "The file could not be read");
    } finally {
      setBusy(false);
    }
  }

  // Options change what is valid (e.g. creating missing locations), so re-check.
  function setOption(patch: Partial<typeof DEFAULTS>) {
    const next = { ...options, ...patch };
    setOptions(next);
    if (file && !report?.committed) void run(file, next, false);
  }

  const canImport = report && !report.committed && report.valid_rows > 0 && (report.error_rows === 0 || options.skipInvalid);

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <div>
        <h1 className="text-lg font-semibold tracking-tight">Import items from CSV</h1>
        <p className="text-sm text-muted-foreground">
          Every row becomes a new item with a new inventory code. Nothing is written until you have seen the check and confirmed.
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-3 rounded-lg border p-4">
        <input
          ref={input}
          type="file"
          accept=".csv,text/csv"
          className="sr-only"
          aria-label="CSV file"
          onChange={(e) => {
            const f = e.target.files?.[0] ?? null;
            setFile(f);
            setReport(null);
            if (f) void run(f, options, false);
          }}
        />
        <Button onClick={() => input.current?.click()} disabled={busy}>
          <FileUp /> {file ? "Choose another file" : "Choose a CSV file"}
        </Button>
        {file && <span className="text-sm text-muted-foreground">{file.name}</span>}
        <span className="ml-auto flex gap-2">
          <Button variant="outline" size="sm" render={<a href={api.importTemplateUrl} download />}>
            <Download /> Template
          </Button>
        </span>
        <p className="w-full text-xs text-muted-foreground">
          Needs a <b>category</b> and a <b>model</b> column. Optional: manufacturer, part_number, revision, chipset_manufacturer, chipset, condition,
          test_status, test_notes, <b>location</b> (a full path such as “Workshop &gt; Shelf 2 &gt; Box 3”), <b>position</b>, notes, acquired_on
          (YYYY-MM-DD), identification_confidence. A file from the CSV export works as is.
        </p>
      </div>

      <fieldset className="grid gap-2 text-sm sm:grid-cols-3">
        <legend className="sr-only">Options</legend>
        {(
          [
            ["createCategories", "Create missing categories"],
            ["createLocations", "Create missing locations"],
            ["skipInvalid", "Skip rows with errors"],
          ] as const
        ).map(([key, label]) => (
          <label key={key} className="flex items-center gap-2">
            <input
              type="checkbox"
              className="size-4 accent-primary"
              checked={options[key]}
              disabled={busy || report?.committed}
              onChange={(e) => setOption({ [key]: e.target.checked })}
            />
            {label}
          </label>
        ))}
      </fieldset>

      {busy && (
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" /> Working…
        </p>
      )}
      {error && (
        <p role="alert" className="rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
          {error}
        </p>
      )}

      {report && (
        <section className="space-y-4" aria-label="Check result">
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant="secondary">{report.total_rows.toLocaleString()} rows</Badge>
            <Badge variant="secondary" className="bg-emerald-500/15 text-emerald-700 dark:text-emerald-300">
              {report.valid_rows.toLocaleString()} ready
            </Badge>
            {report.error_rows > 0 && (
              <Badge variant="secondary" className="bg-red-500/15 text-red-700 dark:text-red-300">
                {report.error_rows.toLocaleString()} with errors
              </Badge>
            )}
          </div>

          {report.committed && (
            <p className="flex items-center gap-2 rounded-md bg-emerald-500/10 p-3 text-sm text-emerald-800 dark:text-emerald-200">
              <CheckCircle2 className="size-4" /> Imported {report.imported.toLocaleString()} items.{" "}
              <Link href="/" className="font-medium underline">
                See the inventory
              </Link>
            </p>
          )}
          {report.blocked && (
            <p className="rounded-md bg-amber-500/10 p-3 text-sm text-amber-800 dark:text-amber-200">Nothing was imported because of the errors below.</p>
          )}

          {report.warnings.length > 0 && (
            <ul className="space-y-1 text-sm text-muted-foreground">
              {report.warnings.map((w) => (
                <li key={w} className="flex gap-2">
                  <TriangleAlert className="mt-0.5 size-4 shrink-0 text-amber-600" /> {w}
                </li>
              ))}
            </ul>
          )}
          {(report.new_categories.length > 0 || report.new_locations.length > 0) && (
            <div className="rounded-md border p-3 text-sm">
              {report.new_categories.length > 0 && (
                <p>
                  {report.committed ? "Created" : "Will create"} categories: <b>{report.new_categories.join(", ")}</b>
                </p>
              )}
              {report.new_locations.length > 0 && (
                <p>
                  {report.committed ? "Created" : "Will create"} locations: <b>{report.new_locations.join(" · ")}</b>
                </p>
              )}
            </div>
          )}

          {report.errors.length > 0 && (
            <div className="overflow-x-auto rounded-md border">
              <table className="w-full text-left text-sm">
                <thead className="bg-muted/50 text-xs text-muted-foreground">
                  <tr>
                    <th className="w-16 px-3 py-2">Line</th>
                    <th className="px-3 py-2">Problem</th>
                  </tr>
                </thead>
                <tbody>
                  {report.errors.map((e) => (
                    <tr key={`${e.line}-${e.message}`} className="border-t">
                      <td className="px-3 py-1.5 font-mono">{e.line}</td>
                      <td className="px-3 py-1.5">{e.message}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {report.errors_truncated && <p className="border-t px-3 py-2 text-xs text-muted-foreground">Only the first {report.errors.length} errors are shown.</p>}
            </div>
          )}

          {report.preview.length > 0 && !report.committed && (
            <div className="overflow-x-auto rounded-md border">
              <p className="px-3 py-2 text-xs text-muted-foreground">First {report.preview.length} valid rows</p>
              <table className="w-full text-left text-sm">
                <thead className="bg-muted/50 text-xs text-muted-foreground">
                  <tr>
                    {["Category", "Model", "Manufacturer", "Condition", "Test status", "Location", "Pos."].map((h) => (
                      <th key={h} className="px-3 py-2">
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {report.preview.map((r) => (
                    <tr key={String(r.line)} className="border-t">
                      <td className="px-3 py-1.5">{r.category}</td>
                      <td className="px-3 py-1.5 font-medium">{r.model}</td>
                      <td className="px-3 py-1.5">{r.manufacturer}</td>
                      <td className="px-3 py-1.5">{r.condition}</td>
                      <td className="px-3 py-1.5">{r.test_status}</td>
                      <td className="px-3 py-1.5">{r.location}</td>
                      <td className="px-3 py-1.5">{r.position}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {!report.committed && (
            <Button disabled={!canImport || busy} onClick={() => file && void run(file, options, true)}>
              {busy && <Loader2 className="animate-spin" />} Import {report.valid_rows.toLocaleString()} item{report.valid_rows === 1 ? "" : "s"}
            </Button>
          )}
          {!report.committed && report.error_rows > 0 && !options.skipInvalid && (
            <p className="text-xs text-muted-foreground">Fix the file and choose it again, or tick “Skip rows with errors” to import only the good rows.</p>
          )}
        </section>
      )}
    </div>
  );
}
