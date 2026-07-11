import { Loader2 } from "lucide-react";

import { cn } from "@/lib/utils";

// Single loading expression shared by client navigation and Suspense fallbacks.
export function LoadingOverlay({ fullPage }: { fullPage?: boolean }) {
  return (
    <div
      role="status"
      aria-live="polite"
      className={cn(
        "pointer-events-none z-30 flex flex-col items-center justify-center gap-2 bg-background/60 backdrop-blur-[2px]",
        fullPage ? "fixed inset-0" : "absolute inset-0",
      )}
    >
      <Loader2 className="h-8 w-8 animate-spin text-primary" strokeWidth={2.5} />
      <span className="text-xs font-medium text-foreground">Loading…</span>
    </div>
  );
}
