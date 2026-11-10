"use client";

import { Camera, CameraOff, Loader2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";

const FORMATS = ["code_128", "code_39", "ean_13", "ean_8", "upc_a", "upc_e", "itf", "codabar", "qr_code", "data_matrix"] as const;

interface Detector {
  detect(source: HTMLVideoElement): Promise<{ rawValue: string }[]>;
}

/** The browser's own detector where there is one (Chrome, Android); otherwise a small decoder that
 *  runs in the page (Safari, Firefox). Its WebAssembly file is served by this app, not a CDN. */
async function makeDetector(): Promise<Detector> {
  const native = (window as unknown as { BarcodeDetector?: new (o: { formats: readonly string[] }) => Detector }).BarcodeDetector;
  if (native) return new native({ formats: FORMATS });
  const lib = await import("barcode-detector/ponyfill");
  lib.prepareZXingModule({
    overrides: { locateFile: (path: string, prefix: string) => (path.endsWith(".wasm") ? "/vendor/zxing_reader.wasm" : prefix + path) },
  });
  return new lib.BarcodeDetector({ formats: [...FORMATS] });
}

/** Can this browser open a camera? It needs a secure page (https, or localhost). */
export function cameraAvailable(): boolean {
  return typeof navigator !== "undefined" && !!navigator.mediaDevices?.getUserMedia && window.isSecureContext;
}

/** A live camera view that reads the first barcode it sees and hands it over. */
export function CameraScanner({ open, onClose, onResult }: { open: boolean; onClose: () => void; onResult: (text: string) => void }) {
  const video = useRef<HTMLVideoElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  // The latest callback, so the camera is not restarted when the parent re-renders.
  const handler = useRef(onResult);
  useEffect(() => {
    handler.current = onResult;
  });

  useEffect(() => {
    if (!open) return;
    let stopped = false;
    let stream: MediaStream | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    /* eslint-disable react-hooks/set-state-in-effect -- resetting the dialog each time it opens */
    setError(null);
    setReady(false);
    /* eslint-enable react-hooks/set-state-in-effect */
    (async () => {
      try {
        const [detector, media] = await Promise.all([
          makeDetector(),
          navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: "environment" } }, audio: false }),
        ]);
        stream = media;
        if (stopped) return media.getTracks().forEach((t) => t.stop());
        const el = video.current;
        if (!el) return;
        el.srcObject = media;
        await el.play();
        setReady(true);
        const tick = async () => {
          if (stopped) return;
          try {
            const found = el.readyState >= 2 ? await detector.detect(el) : [];
            const text = found.find((f) => f.rawValue)?.rawValue;
            if (text) {
              stopped = true;
              handler.current(text);
              return;
            }
          } catch {
            /* a frame that cannot be read is skipped */
          }
          timer = setTimeout(tick, 200);
        };
        void tick();
      } catch (e) {
        if (stopped) return;
        const name = e instanceof DOMException ? e.name : "";
        setError(
          name === "NotAllowedError"
            ? "The camera is blocked. Allow it for this site in the browser's settings and try again."
            : name === "NotFoundError"
              ? "No camera was found on this device."
              : "The camera could not be started.",
        );
      }
    })();
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      stream?.getTracks().forEach((t) => t.stop());
    };
  }, [open]);

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Scan with the camera</DialogTitle>
          <DialogDescription>Hold a barcode in front of the camera. It is read as soon as it is clear.</DialogDescription>
        </DialogHeader>
        {error ? (
          <p role="alert" className="flex items-start gap-2 rounded-md bg-destructive/10 p-3 text-sm text-destructive">
            <CameraOff className="mt-0.5 size-4 shrink-0" /> {error}
          </p>
        ) : (
          <div className="relative overflow-hidden rounded-lg bg-black">
            <video ref={video} playsInline muted className="aspect-[4/3] w-full object-cover" aria-label="Camera view" />
            {!ready && (
              <div className="absolute inset-0 flex items-center justify-center text-white/80">
                <Loader2 className="size-6 animate-spin" />
              </div>
            )}
            <div className="pointer-events-none absolute inset-x-6 top-1/2 h-0.5 -translate-y-1/2 bg-red-500/70" />
          </div>
        )}
        <Button variant="outline" onClick={onClose}>
          Cancel
        </Button>
      </DialogContent>
    </Dialog>
  );
}

/** A camera button that fills a field from a scanned barcode. Renders nothing where there is no camera. */
export function ScanIntoField({ onResult, label = "Scan with the camera" }: { onResult: (text: string) => void; label?: string }) {
  const [open, setOpen] = useState(false);
  const [supported, setSupported] = useState(false);
  useEffect(() => {
    /* eslint-disable-next-line react-hooks/set-state-in-effect -- browser-only capability check */
    setSupported(cameraAvailable());
  }, []);
  if (!supported) return null;
  return (
    <>
      <Button type="button" variant="outline" size="icon" aria-label={label} title={label} onClick={() => setOpen(true)}>
        <Camera />
      </Button>
      <CameraScanner
        open={open}
        onClose={() => setOpen(false)}
        onResult={(text) => {
          setOpen(false);
          onResult(text);
        }}
      />
    </>
  );
}
