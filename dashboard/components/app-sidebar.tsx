"use client";

import { usePathname } from "next/navigation";
import { LayoutDashboard, LogOut, ScrollText, TrafficCone, type LucideIcon } from "lucide-react";

import { logout } from "@/app/login/actions";
import { PROJECT } from "@/lib/config";
import { cn } from "@/lib/utils";
import { usePendingNav } from "./pending-nav";
import { ThemeToggle } from "./theme-toggle";

function SignOutButton() {
  return (
    <form action={logout}>
      <button
        type="submit"
        className="inline-flex h-7 items-center gap-1.5 rounded-md px-2 text-xs font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
      >
        <LogOut className="h-3.5 w-3.5" strokeWidth={2} /> Sign out
      </button>
    </form>
  );
}

const NAV: { href: string; label: string; icon: LucideIcon }[] = [
  { href: "/", label: "Overview", icon: LayoutDashboard },
  { href: "/requests", label: "Requests", icon: ScrollText },
];

function matches(href: string, current: string) {
  return href === "/" ? current === "/" : current.startsWith(href);
}

function Brand() {
  return (
    <div className="flex items-center gap-2">
      <TrafficCone className="h-[18px] w-[18px] text-primary" strokeWidth={2} />
      <div className="flex flex-col leading-none">
        <span className="text-sm font-semibold tracking-tight">Tollbooth</span>
        <span className="text-[10px] uppercase tracking-wider text-muted-foreground">console</span>
      </div>
    </div>
  );
}

function NavLink({ href, label, icon: Icon, active }: { href: string; label: string; icon: LucideIcon; active: boolean }) {
  const { navigate } = usePendingNav();
  return (
    <button
      type="button"
      onClick={() => navigate(href)}
      aria-current={active ? "page" : undefined}
      className={cn(
        "group flex w-full items-center gap-2 rounded-md border-l-2 border-transparent px-2 py-1.5 text-sm font-medium text-muted-foreground transition-colors",
        "hover:bg-accent hover:text-foreground",
        active && "border-primary bg-primary/10 font-semibold text-foreground",
      )}
    >
      <Icon
        className={cn(
          "h-4 w-4 shrink-0 transition-colors",
          active ? "text-primary" : "text-muted-foreground group-hover:text-foreground",
        )}
        strokeWidth={2}
      />
      <span className="truncate">{label}</span>
    </button>
  );
}

function useActiveHref() {
  const pathname = usePathname();
  const { pending, pendingHref } = usePendingNav();
  return pending && pendingHref ? pendingHref : pathname;
}

/** Fixed rail on md+. */
export function AppSidebar({ authEnabled }: { authEnabled?: boolean }) {
  const active = useActiveHref();
  return (
    <aside className="sticky top-0 hidden h-svh w-52 shrink-0 flex-col border-r border-border bg-card md:flex">
      <div className="flex h-12 items-center border-b border-border px-3">
        <Brand />
      </div>
      <nav className="flex flex-1 flex-col gap-0.5 p-2">
        <div className="px-2 pb-1.5 pt-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
          Observability
        </div>
        {NAV.map((item) => (
          <NavLink key={item.href} {...item} active={matches(item.href, active)} />
        ))}
      </nav>
      <div className="mt-auto flex flex-col gap-2 border-t border-border p-3">
        <div className="flex items-center justify-between text-xs">
          <span className="text-muted-foreground">project</span>
          <span className="font-mono tabular-nums">{PROJECT}</span>
        </div>
        <div className="flex items-center justify-between gap-2">
          <ThemeToggle />
          {authEnabled ? <SignOutButton /> : null}
        </div>
      </div>
    </aside>
  );
}

/** Top bar on mobile (md:hidden). */
export function MobileBar({ authEnabled }: { authEnabled?: boolean }) {
  const active = useActiveHref();
  return (
    <header className="sticky top-0 z-30 flex h-12 items-center gap-3 border-b border-border bg-card px-4 md:hidden">
      <Brand />
      <nav className="ml-auto flex items-center gap-1">
        {NAV.map((item) => (
          <NavLink key={item.href} {...item} active={matches(item.href, active)} />
        ))}
        <ThemeToggle />
        {authEnabled ? <SignOutButton /> : null}
      </nav>
    </header>
  );
}
