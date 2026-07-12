"use client";

import { createContext, useCallback, useContext, useState, useTransition } from "react";
import { useRouter } from "next/navigation";

import { LoadingOverlay } from "./loading-overlay";

interface PendingNav {
  navigate: (href: string) => void;
  pending: boolean;
  pendingHref: string | null;
}

const Ctx = createContext<PendingNav | null>(null);

export function usePendingNav(): PendingNav {
  const c = useContext(Ctx);
  if (!c) throw new Error("usePendingNav must be used within <PendingNavProvider>");
  return c;
}

// All in-app navigation goes through one useTransition, so every menu/link/CTA
// shares the same loading treatment and the destination lights up immediately.
export function PendingNavProvider({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [pendingHref, setPendingHref] = useState<string | null>(null);

  const navigate = useCallback(
    (href: string) => {
      setPendingHref(href);
      startTransition(() => router.push(href));
    },
    [router],
  );

  return <Ctx.Provider value={{ navigate, pending, pendingHref }}>{children}</Ctx.Provider>;
}

// The scrolling main column; shows the overlay while a navigation is in flight.
export function MainArea({ children }: { children: React.ReactNode }) {
  const { pending } = usePendingNav();
  return (
    <main className="relative flex min-w-0 flex-1 flex-col" aria-busy={pending || undefined}>
      {children}
      {pending && <LoadingOverlay />}
    </main>
  );
}
