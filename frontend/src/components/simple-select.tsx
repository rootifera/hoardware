"use client";

import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

export interface Option {
  value: string;
  label: string;
}

const ANY = "__any__";

/** Thin wrapper over the Select primitive for plain value/label lists.
 *  With `anyLabel`, an extra first option maps to the empty string. */
export function SimpleSelect({
  value,
  onChange,
  options,
  anyLabel,
  placeholder,
  className,
  size,
  id,
  "aria-label": ariaLabel,
}: {
  value: string;
  onChange: (value: string) => void;
  options: Option[];
  anyLabel?: string;
  placeholder?: string;
  className?: string;
  size?: "sm" | "default";
  id?: string;
  "aria-label"?: string;
}) {
  const items: Option[] = anyLabel ? [{ value: ANY, label: anyLabel }, ...options] : options;
  return (
    <Select
      items={items}
      value={anyLabel && value === "" ? ANY : value || null}
      onValueChange={(v) => onChange(v === ANY || v == null ? "" : String(v))}
    >
      <SelectTrigger id={id} size={size} className={className} aria-label={ariaLabel}>
        <SelectValue placeholder={placeholder} />
      </SelectTrigger>
      <SelectContent>
        {items.map((o) => (
          <SelectItem key={o.value} value={o.value}>
            {o.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
