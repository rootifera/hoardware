import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import type { Condition, Confidence, TestStatus } from "@/lib/types";

const TEST_STYLES: Record<TestStatus, string> = {
  "Full Test": "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300",
  POST: "bg-sky-500/15 text-sky-700 dark:text-sky-300",
  Untested: "bg-muted text-muted-foreground",
  Unknown: "bg-amber-500/15 text-amber-700 dark:text-amber-300",
  Dead: "bg-red-500/15 text-red-700 dark:text-red-300",
};

const CONDITION_STYLES: Record<Condition, string> = {
  "New / Sealed": "text-emerald-700 dark:text-emerald-300",
  Excellent: "text-emerald-700 dark:text-emerald-300",
  Good: "text-foreground",
  Fair: "text-amber-700 dark:text-amber-300",
  Poor: "text-orange-700 dark:text-orange-300",
  Damaged: "text-red-700 dark:text-red-300",
  Unknown: "text-muted-foreground",
};

export function TestStatusBadge({ status, label, className }: { status: TestStatus; label?: string; className?: string }) {
  return (
    <Badge variant="secondary" className={cn("border-0", TEST_STYLES[status], className)}>
      {label ?? status}
    </Badge>
  );
}

export function ConditionBadge({ condition, label, className }: { condition: Condition; label?: string; className?: string }) {
  return (
    <Badge variant="outline" className={cn(CONDITION_STYLES[condition], className)}>
      {label ?? condition}
    </Badge>
  );
}

export function ConfidenceBadge({ confidence }: { confidence: Confidence }) {
  if (confidence === "unidentified") return null;
  return (
    <Badge variant="outline" className="text-muted-foreground">
      {confidence === "confirmed" ? "ID confirmed" : "ID candidate"}
    </Badge>
  );
}
