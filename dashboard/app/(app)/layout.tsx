import { AppSidebar, MobileBar, type ProjectContext } from "@/components/app-sidebar";
import { MainArea, PendingNavProvider } from "@/components/pending-nav";
import { AUTH_MODE } from "@/lib/auth";
import { currentProject, switchableProjects } from "@/lib/project";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  // Sign-out shows whenever there's a session to end (single or multi).
  const authEnabled = AUTH_MODE !== "none";

  // The tenant context — only multi has one. Resolved here, in the layout, so the
  // sidebar switcher and the "Project" nav item exist on every screen without each
  // page re-fetching them.
  let project: ProjectContext | undefined;
  if (AUTH_MODE === "multi") {
    const [current, projects] = await Promise.all([currentProject(), switchableProjects()]);
    project = { current, projects };
  }

  return (
    <PendingNavProvider>
      <div className="flex min-h-svh flex-col md:flex-row">
        <MobileBar authEnabled={authEnabled} project={project} />
        <AppSidebar authEnabled={authEnabled} project={project} />
        <MainArea>{children}</MainArea>
      </div>
    </PendingNavProvider>
  );
}
