"use client";

import { usePathname } from "next/navigation";
import { BellRing, CircleDollarSign, KeyRound, LayoutDashboard, LogOut, ScrollText, SlidersHorizontal, Sparkles, TrafficCone, Users, type LucideIcon } from "lucide-react";

import { logout } from "@/app/login/actions";
import { PROJECT } from "@/lib/config";
import { cn } from "@/lib/utils";
import { usePendingNav } from "./pending-nav";
import { ProjectSwitcher, type SwitcherProject } from "./ProjectSwitcher";
import { ThemeToggle } from "./theme-toggle";

/** In multi mode the layout resolves the session's project and the switchable list and
 *  passes them down; in none/single these are undefined and the env project name shows. */
export interface ProjectContext {
  current: { id: string; name: string; role: string };
  projects: SwitcherProject[];
}

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

type NavItem = { href: string; label: string; icon: LucideIcon };

// Grouped by what you came here to do: watch what happened, change what the gateway
// will do next, or arrange to be told without having to watch at all.
const NAV: { section: string; items: NavItem[] }[] = [
  {
    section: "Observability",
    items: [
      { href: "/", label: "Overview", icon: LayoutDashboard },
      { href: "/requests", label: "Requests", icon: ScrollText },
      // Quality sits with the other things you come here to *watch*, not under Gateway:
      // it describes what the calls were worth, not what the gateway will do next.
      { href: "/quality", label: "Quality", icon: Sparkles },
    ],
  },
  {
    section: "Gateway",
    items: [
      { href: "/keys", label: "API Keys", icon: KeyRound },
      { href: "/pricing", label: "Pricing", icon: CircleDollarSign },
    ],
  },
  {
    section: "Workflows",
    items: [{ href: "/rules", label: "Rules", icon: BellRing }],
  },
  {
    section: "Console",
    items: [{ href: "/settings", label: "Settings", icon: SlidersHorizontal }],
  },
];

/** The nav, plus the multi-mode "Project" (members/roles) item when there's a tenant. */
function navFor(multi: boolean): { section: string; items: NavItem[] }[] {
  if (!multi) return NAV;
  return NAV.map((group) =>
    group.section === "Console"
      ? { ...group, items: [{ href: "/project", label: "Project", icon: Users }, ...group.items] }
      : group,
  );
}

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
export function AppSidebar({ authEnabled, project }: { authEnabled?: boolean; project?: ProjectContext }) {
  const active = useActiveHref();
  return (
    <aside className="sticky top-0 hidden h-svh w-52 shrink-0 flex-col border-r border-border bg-card md:flex">
      <div className="flex h-12 items-center border-b border-border px-3">
        <Brand />
      </div>
      <nav className="flex flex-1 flex-col gap-0.5 p-2">
        {navFor(Boolean(project)).map((group) => (
          <div key={group.section} className="flex flex-col gap-0.5">
            <div className="px-2 pb-1.5 pt-2 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
              {group.section}
            </div>
            {group.items.map((item) => (
              <NavLink key={item.href} {...item} active={matches(item.href, active)} />
            ))}
          </div>
        ))}
      </nav>
      <div className="mt-auto flex flex-col gap-2 border-t border-border p-3">
        {project ? (
          <div className="flex flex-col gap-1">
            <span className="px-0.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
              project
            </span>
            <ProjectSwitcher current={project.current} projects={project.projects} />
          </div>
        ) : (
          <div className="flex items-center justify-between text-xs">
            <span className="text-muted-foreground">project</span>
            <span className="font-mono tabular-nums">{PROJECT}</span>
          </div>
        )}
        <div className="flex items-center justify-between gap-2">
          <ThemeToggle />
          {authEnabled ? <SignOutButton /> : null}
        </div>
      </div>
    </aside>
  );
}

/** Top bar on mobile (md:hidden). */
export function MobileBar({ authEnabled, project }: { authEnabled?: boolean; project?: ProjectContext }) {
  const active = useActiveHref();
  return (
    <header className="sticky top-0 z-30 flex h-12 items-center gap-3 border-b border-border bg-card px-4 md:hidden">
      <Brand />
      <nav className="ml-auto flex items-center gap-1">
        {navFor(Boolean(project)).flatMap((group) => group.items).map((item) => (
          <NavLink key={item.href} {...item} active={matches(item.href, active)} />
        ))}
        <ThemeToggle />
        {authEnabled ? <SignOutButton /> : null}
      </nav>
    </header>
  );
}
