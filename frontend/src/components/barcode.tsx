import { bars, canEncode } from "@/lib/code128";
import { cn } from "@/lib/utils";

/** A Code 128 barcode as an SVG that scales to its container (with the quiet zones scanners need). */
export function Barcode({ value, className }: { value: string; className?: string }) {
  if (!canEncode(value)) return null;
  const QUIET = 10; // modules of white on each side
  const { bars: rects, modules } = bars(value);
  return (
    <svg
      role="img"
      aria-label={`Barcode ${value}`}
      viewBox={`0 0 ${modules + QUIET * 2} 40`}
      preserveAspectRatio="none"
      shapeRendering="crispEdges"
      className={cn("block bg-white", className)}
    >
      <rect width={modules + QUIET * 2} height={40} fill="#fff" />
      {rects.map(([x, w]) => (
        <rect key={x} x={x + QUIET} width={w} height={40} fill="#000" />
      ))}
    </svg>
  );
}
