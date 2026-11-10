"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { toast } from "sonner";
import { looksLikeScan, noteKey } from "@/lib/scan";
import { resolveScan } from "@/lib/scan-open";

const MAX_GAP_MS = 60; // a scanner types faster than this between keys; a person does not

/** Scan an item's barcode anywhere in the app and its page opens. Works with any scanner that types
 *  the code and presses Enter, whenever no text field is focused. */
export function ScanListener() {
  const router = useRouter();
  useEffect(() => {
    let buffer = "";
    let last = 0;
    let fast = true;
    const onKey = (e: KeyboardEvent) => {
      noteKey(e.timeStamp);
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const t = e.target as HTMLElement | null;
      const typing = !!t && (t.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(t.tagName));
      if (typing || document.querySelector("[role=dialog], [role=alertdialog]")) {
        buffer = "";
        return;
      }
      if (e.key === "Enter") {
        const code = buffer;
        buffer = "";
        if (code.length >= 5 && fast && looksLikeScan(code)) {
          e.preventDefault();
          resolveScan(code)
            .then((r) => {
              if (r.kind === "none") return toast.error(r.message);
              toast.success(r.message);
              router.push(r.href);
            })
            .catch(() => toast.error("The scan could not be looked up"));
        }
        return;
      }
      if (e.key.length !== 1) return;
      if (e.timeStamp - last > MAX_GAP_MS) {
        buffer = "";
        fast = true;
      } else if (buffer.length > 0) {
        fast = fast && e.timeStamp - last <= MAX_GAP_MS;
      }
      buffer += e.key;
      last = e.timeStamp;
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [router]);
  return null;
}
