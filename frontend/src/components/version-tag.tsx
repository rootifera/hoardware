"use client";

import { useQuery } from "@tanstack/react-query";
import { ArrowUpCircle } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { api, type VersionRelease } from "@/lib/api";

const label = (r: VersionRelease) => [r.version, r.build_name && `“${r.build_name}”`].filter(Boolean).join(" ");
const when = (t: number | null) => (t ? new Date(t * 1000).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" }) : null);

/** The installed version in a quiet corner of the screen. When the git repository has published a
 *  newer one it turns into a small "update available" pill that says what to do. */
export function VersionTag() {
  const version = useQuery({ queryKey: ["version"], queryFn: api.version, staleTime: 10 * 60_000, refetchInterval: 30 * 60_000, retry: false });
  const v = version.data;
  if (!v) return null;
  const built = when(v.build_time);

  if (v.update) {
    return (
      <div className="fixed bottom-2 left-3 z-20 print:hidden">
        <Popover>
          <PopoverTrigger
            render={
              <button
                type="button"
                className="flex items-center gap-1 rounded-full border border-amber-300 bg-amber-50 px-2 py-0.5 text-[11px] font-medium text-amber-950 shadow-sm hover:bg-amber-100 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-100 dark:hover:bg-amber-900"
                aria-label={`Update available: version ${v.update.version}`}
              />
            }
          >
            <ArrowUpCircle className="size-3" /> {v.update.version} available
          </PopoverTrigger>
          <PopoverContent side="top" align="start" className="w-80 text-sm">
            <p className="font-medium">A new version is available</p>
            <p className="text-muted-foreground">
              {v.app_name} {label(v.update)}
              {when(v.update.build_time) ? `, published ${when(v.update.build_time)}` : ""}.
            </p>
            <p className="text-muted-foreground">
              You are running {label(v)}
              {built ? `, built ${built}` : ""}.
            </p>
            <p>
              To update, run <code className="rounded bg-muted px-1 font-mono text-xs">./deploy.sh</code> in the install folder on the server.
            </p>
          </PopoverContent>
        </Popover>
      </div>
    );
  }
  return (
    <div
      className="pointer-events-none fixed bottom-1 left-2 z-20 rounded bg-background/70 px-1 text-[11px] text-muted-foreground select-none print:hidden"
      title={[label(v), built && `built ${built}`, v.check.enabled ? (v.check.error ? "update check failed" : "up to date") : "update check is off"].filter(Boolean).join(" · ")}
    >
      {v.app_name} {v.version}
      {v.build_name ? ` · ${v.build_name}` : ""}
    </div>
  );
}
