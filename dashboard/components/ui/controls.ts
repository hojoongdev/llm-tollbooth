// Shared control surfaces, so a form on one screen is the same object as a form
// on another.

export const INPUT =
  "h-8 rounded-md border border-border bg-background px-2.5 text-sm outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background";

export const BUTTON =
  "inline-flex h-8 items-center justify-center gap-1.5 rounded-md bg-primary px-3 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50";

/** Secondary action: an outline, so a destructive click is never the loud one. */
export const BUTTON_QUIET =
  "inline-flex h-8 items-center justify-center gap-1.5 rounded-md border border-border px-2.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-50";
