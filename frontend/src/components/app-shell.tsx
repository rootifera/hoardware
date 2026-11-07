"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Cpu, Keyboard, LogOut, Moon, Plus, Sun } from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useTheme } from "next-themes";
import { useEffect, useState } from "react";
import { AUTH_KEY } from "@/components/auth-gate";
import { useQuickAdd } from "@/components/quick-add";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";

const NAV = [
  { href: "/", label: "Inventory" },
  { href: "/locations", label: "Locations" },
  { href: "/categories", label: "Categories" },
  { href: "/import", label: "Import" },
];

const SHORTCUTS: { keys: string; what: string }[] = [
  { keys: "/", what: "Jump to search" },
  { keys: "n", what: "Quick add" },
  { keys: "?", what: "Show this list" },
  { keys: "Ctrl/⌘ + S", what: "Save the item you are editing" },
  { keys: "Shift + click", what: "Select a range of items in a list" },
  { keys: "Enter in Quick add", what: "Save" },
  { keys: "Esc", what: "Close a dialog or menu" },
];

export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const { open } = useQuickAdd();
  const { resolvedTheme, setTheme } = useTheme();
  const [help, setHelp] = useState(false);
  const queryClient = useQueryClient();
  const auth = useQuery({ queryKey: AUTH_KEY, queryFn: api.authStatus, staleTime: 60_000 });
  // Things that need attention but do not stop the app: late backups, unreachable photo storage.
  const health = useQuery({ queryKey: ["health"], queryFn: api.health, refetchInterval: 10 * 60_000, staleTime: 5 * 60_000, retry: false });
  const warnings: string[] = [];
  const backups = health.data?.backups;
  if (backups?.status === "failing") warnings.push(`The last scheduled backup failed${backups.error ? `: ${backups.error}` : "."}`);
  else if (backups?.status === "stale") warnings.push(`No backup for ${Math.round((backups.age_hours ?? 0) / 24)} day(s): scheduled backups are not running.`);
  else if (backups?.status === "none") warnings.push("No backup has been made yet.");
  if (health.data && health.data.storage.status !== "ok") warnings.push("Photo and file storage is not reachable: uploads and downloads will fail.");
  async function signOut() {
    await api.logout().catch(() => {});
    queryClient.removeQueries({ predicate: (q) => q.queryKey[0] !== AUTH_KEY[0] });
    await queryClient.invalidateQueries({ queryKey: AUTH_KEY });
  }

  // "?" shows the shortcut list.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "?" || e.metaKey || e.ctrlKey || e.altKey) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(t.tagName))) return;
      if (document.querySelector("[role=dialog], [role=alertdialog]")) return;
      e.preventDefault();
      setHelp(true);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // "/" jumps to search from anywhere.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "/" || e.metaKey || e.ctrlKey || e.altKey) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(t.tagName))) return;
      e.preventDefault();
      const input = document.getElementById("search-input") as HTMLInputElement | null;
      if (input) input.focus();
      else router.push("/?focus=1");
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [router]);

  return (
    <div className="flex min-h-screen flex-col">
      <header className="sticky top-0 z-30 border-b bg-background/85 backdrop-blur print:hidden">
        <div className="mx-auto flex h-14 w-full max-w-7xl items-center gap-2 px-4 sm:gap-4">
          <Link href="/" aria-label="Hoardware" className="flex items-center gap-2 font-semibold tracking-tight">
            <Cpu className="size-5" /> <span className="hidden sm:inline">Hoardware</span>
          </Link>
          <nav className="flex min-w-0 items-center gap-0.5 overflow-x-auto text-sm sm:gap-1">
            {NAV.map((n) => {
              const active = n.href === "/" ? pathname === "/" || pathname.startsWith("/items") : pathname.startsWith(n.href);
              return (
                <Link
                  key={n.href}
                  href={n.href}
                  className={cn(
                    "shrink-0 rounded-md px-2 py-1.5 text-muted-foreground transition-colors hover:text-foreground sm:px-2.5",
                    active && "bg-muted text-foreground",
                  )}
                >
                  {n.label}
                </Link>
              );
            })}
          </nav>
          <div className="ml-auto flex shrink-0 items-center gap-2">
            <Button aria-label="Quick add" onClick={() => open()}>
              <Plus /> <span className="hidden sm:inline">Quick add</span>
              <kbd className="ml-1 hidden rounded bg-primary-foreground/20 px-1 font-mono text-[10px] sm:inline">N</kbd>
            </Button>
            <Button variant="ghost" size="icon" aria-label="Keyboard shortcuts" className="hidden sm:inline-flex" onClick={() => setHelp(true)}>
              <Keyboard />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              aria-label="Toggle theme"
              onClick={() => setTheme(resolvedTheme === "dark" ? "light" : "dark")}
            >
              <Sun className="dark:hidden" />
              <Moon className="hidden dark:block" />
            </Button>
            {auth.data?.auth_required && (
              <Button variant="ghost" size="icon" aria-label="Sign out" title={`Sign out${auth.data.username ? ` (${auth.data.username})` : ""}`} onClick={() => void signOut()}>
                <LogOut />
              </Button>
            )}
          </div>
        </div>
      </header>
      {warnings.length > 0 && (
        <div role="status" className="border-b bg-amber-50 text-amber-950 dark:bg-amber-950/40 dark:text-amber-100 print:hidden">
          <div className="mx-auto flex w-full max-w-7xl items-start gap-2 px-4 py-2 text-sm">
            <AlertTriangle className="mt-0.5 size-4 shrink-0" />
            <div className="min-w-0">
              {warnings.map((w) => (
                <p key={w} className="break-words">
                  {w}
                </p>
              ))}
            </div>
          </div>
        </div>
      )}
      <Dialog open={help} onOpenChange={setHelp}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Keyboard shortcuts</DialogTitle>
            <DialogDescription>Shortcuts that type a letter work when you are not in a text field.</DialogDescription>
          </DialogHeader>
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
            {SHORTCUTS.map((sc) => (
              <div key={sc.keys} className="contents">
                <dt>
                  <kbd className="rounded border bg-muted px-1.5 py-0.5 font-mono text-xs">{sc.keys}</kbd>
                </dt>
                <dd className="text-muted-foreground">{sc.what}</dd>
              </div>
            ))}
          </dl>
        </DialogContent>
      </Dialog>
      <main className="mx-auto w-full max-w-7xl flex-1 px-4 py-6 print:max-w-none print:p-0">{children}</main>
    </div>
  );
}
