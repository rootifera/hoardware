"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ClipboardCheck, Loader2, Trash2 } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { SimpleSelect } from "@/components/simple-select";
import { TestStatusBadge } from "@/components/status";
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
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { api } from "@/lib/api";
import { TEST_STATUSES, type ItemDetail, type TestLogEntry, type TestStatus } from "@/lib/types";

const today = () => new Date().toLocaleDateString("en-CA"); // YYYY-MM-DD in local time

/** When and how an item was tested. Status changes are logged automatically;
 *  this also lets you record a test (with a date and notes) by hand. */
export function TestHistory({ item, locked }: { item: ItemDetail; locked: boolean }) {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState<TestStatus>("Full Test");
  const [date, setDate] = useState(today);
  const [notes, setNotes] = useState("");
  const [removing, setRemoving] = useState<TestLogEntry | null>(null);

  const log = useQuery({ queryKey: ["test-log", item.id], queryFn: () => api.testLog(item.id) });

  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: ["test-log", item.id] });
    queryClient.invalidateQueries({ queryKey: ["items"] });
  };
  const add = useMutation({
    mutationFn: () => api.addTestLog(item.id, { status, tested_on: date || null, notes: notes.trim() || null }),
    onSuccess: () => {
      // The item's own status changed too: reload it.
      queryClient.invalidateQueries({ queryKey: ["item", item.id] });
      refresh();
      setOpen(false);
      setNotes("");
      toast.success("Test logged");
    },
    onError: (e) => toast.error(e.message),
  });
  const remove = useMutation({
    mutationFn: (entry: TestLogEntry) => api.deleteTestLog(item.id, entry.id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["item", item.id] });
      refresh();
      setRemoving(null);
    },
    onError: (e) => toast.error(e.message),
  });

  return (
    <section className="space-y-4 rounded-xl border bg-card p-5 sm:p-6">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-base font-semibold tracking-tight">Test history</h2>
        {!open && (
          <Button variant="outline" size="sm" disabled={locked} onClick={() => setOpen(true)}>
            <ClipboardCheck /> Log a test
          </Button>
        )}
      </div>
      {locked && !open && <p className="text-xs text-muted-foreground">Save or revert your edits to log a test.</p>}

      {open && (
        <form
          className="grid gap-3 rounded-md bg-muted/40 p-3 sm:grid-cols-[10rem_10rem_1fr]"
          onSubmit={(e) => {
            e.preventDefault();
            add.mutate();
          }}
        >
          <div className="grid gap-1.5">
            <Label htmlFor="tl-status">Result</Label>
            <SimpleSelect id="tl-status" className="w-full" value={status} onChange={(v) => setStatus(v as TestStatus)} options={TEST_STATUSES.map((s) => ({ value: s, label: s }))} />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="tl-date">Date</Label>
            <Input id="tl-date" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="tl-notes">What was tested</Label>
            <Input id="tl-notes" placeholder="e.g. 3DMark99 on a P2-400" value={notes} onChange={(e) => setNotes(e.target.value)} />
          </div>
          <div className="flex justify-end gap-2 sm:col-span-3">
            <Button type="button" variant="ghost" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={add.isPending}>
              {add.isPending && <Loader2 className="animate-spin" />} Save entry
            </Button>
          </div>
          <p className="text-xs text-muted-foreground sm:col-span-3">
            This also sets the item’s current test status to “{status}”{notes.trim() ? " and replaces its test notes" : ""}.
          </p>
        </form>
      )}

      {log.isPending ? (
        <Skeleton className="h-12 w-full" />
      ) : log.isError ? (
        <p className="text-sm text-destructive">{log.error.message}</p>
      ) : log.data.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          Nothing logged yet. Every change of the test status is recorded here automatically, so you can see when something was tested and what happened.
        </p>
      ) : (
        <ol className="divide-y">
          {log.data.map((entry) => (
            <li key={entry.id} className="flex items-start gap-3 py-2">
              <time className="w-24 shrink-0 pt-0.5 font-mono text-xs text-muted-foreground" dateTime={entry.tested_on}>
                {entry.tested_on}
              </time>
              <TestStatusBadge status={entry.status} />
              <p className="min-w-0 flex-1 whitespace-pre-wrap break-words text-sm text-muted-foreground">{entry.notes}</p>
              <Button variant="ghost" size="icon-sm" aria-label={`Remove the ${entry.tested_on} entry`} onClick={() => setRemoving(entry)}>
                <Trash2 />
              </Button>
            </li>
          ))}
        </ol>
      )}

      <AlertDialog open={removing !== null} onOpenChange={(o) => !o && setRemoving(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove this entry?</AlertDialogTitle>
            <AlertDialogDescription>
              Only the history entry is removed. The item’s current test status stays as it is.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={() => removing && remove.mutate(removing)}>
              Remove
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}
