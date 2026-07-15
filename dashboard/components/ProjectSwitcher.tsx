"use client";

import { useRef } from "react";
import { ChevronsUpDown } from "lucide-react";

import { switchProject } from "@/app/(app)/project/actions";

export interface SwitcherProject {
  id: string;
  name: string;
  role: string;
}

/**
 * The tenant switcher in the sidebar. A native select in a form that submits on change —
 * so it works without a heavyweight menu, and switchProject re-checks membership server
 * side anyway, so a tampered value changes nothing.
 */
export function ProjectSwitcher({
  current,
  projects,
}: {
  current: { id: string; name: string; role: string };
  projects: SwitcherProject[];
}) {
  const formRef = useRef<HTMLFormElement>(null);

  // One project and it's the current one — nothing to switch, so just name it.
  if (projects.length <= 1) {
    return (
      <div className="flex items-center gap-1.5 text-xs">
        <span className="truncate font-medium">{current.name}</span>
        <span className="ml-auto font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
          {current.role}
        </span>
      </div>
    );
  }

  return (
    <form ref={formRef} action={switchProject} className="relative flex items-center">
      <select
        name="project_id"
        defaultValue={current.id}
        onChange={() => formRef.current?.requestSubmit()}
        aria-label="Switch project"
        className="h-7 w-full cursor-pointer appearance-none rounded-md border border-border bg-background pl-2 pr-6 text-xs font-medium outline-none transition-colors hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring"
      >
        {projects.map((p) => (
          <option key={p.id} value={p.id}>
            {p.name} · {p.role}
          </option>
        ))}
      </select>
      <ChevronsUpDown className="pointer-events-none absolute right-1.5 h-3 w-3 text-muted-foreground" strokeWidth={2} />
    </form>
  );
}
