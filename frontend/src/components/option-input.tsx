"use client";

import { Autocomplete } from "@base-ui/react/autocomplete";
import { Check, ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * A text input with a list of predefined values to pick from. Anything else can be
 * typed: the list only speeds things up and keeps spelling consistent.
 */
export function OptionInput({
  value,
  onChange,
  options,
  id,
  placeholder,
  className,
  onFocus,
}: {
  value: string;
  onChange: (value: string) => void;
  options: string[];
  id?: string;
  placeholder?: string;
  className?: string;
  onFocus?: () => void;
}) {
  // Typing narrows the list; with a complete value in the box (or nothing) every option is shown,
  // so changing your mind does not mean clearing the field first.
  const typed = value.trim().toLowerCase();
  const exact = options.some((o) => o.toLowerCase() === typed);
  const shown = !typed || exact ? options : options.filter((o) => o.toLowerCase().includes(typed));

  return (
    <Autocomplete.Root
      items={options}
      filteredItems={shown}
      value={value}
      onValueChange={(v) => onChange(v)}
      openOnInputClick
      mode="none"
    >
      <div className="relative">
        <Autocomplete.Input
          id={id}
          autoComplete="off"
          placeholder={placeholder}
          onFocus={onFocus}
          className={cn(
            "h-8 w-full min-w-0 rounded-lg border border-input bg-transparent py-1 pr-7 pl-2.5 text-base transition-colors outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 md:text-sm dark:bg-input/30",
            className,
          )}
        />
        <Autocomplete.Trigger
          aria-label="Show the predefined values"
          tabIndex={-1}
          className="absolute inset-y-0 right-0 flex w-7 items-center justify-center text-muted-foreground hover:text-foreground"
        >
          <ChevronDown className="size-4" />
        </Autocomplete.Trigger>
      </div>
      <Autocomplete.Portal>
        <Autocomplete.Positioner sideOffset={4} align="start" className="isolate z-[60]">
          <Autocomplete.Popup className="max-h-64 w-(--anchor-width) min-w-36 overflow-y-auto rounded-lg bg-popover p-1 text-popover-foreground shadow-md ring-1 ring-foreground/10">
            <Autocomplete.List>
              {(option: string) => (
                <Autocomplete.Item
                  key={option}
                  value={option}
                  className="flex cursor-default items-center justify-between gap-2 rounded-md px-1.5 py-1 text-sm outline-hidden select-none data-highlighted:bg-accent data-highlighted:text-accent-foreground"
                >
                  {option}
                  {option === value && <Check className="size-3.5" />}
                </Autocomplete.Item>
              )}
            </Autocomplete.List>
          </Autocomplete.Popup>
        </Autocomplete.Positioner>
      </Autocomplete.Portal>
    </Autocomplete.Root>
  );
}
