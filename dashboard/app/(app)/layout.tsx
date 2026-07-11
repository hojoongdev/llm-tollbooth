import { AppSidebar, MobileBar } from "@/components/app-sidebar";
import { MainArea, PendingNavProvider } from "@/components/pending-nav";
import { AUTH_MODE } from "@/lib/auth";

export default function AppLayout({ children }: { children: React.ReactNode }) {
  const authEnabled = AUTH_MODE === "single";
  return (
    <PendingNavProvider>
      <div className="flex min-h-svh flex-col md:flex-row">
        <MobileBar authEnabled={authEnabled} />
        <AppSidebar authEnabled={authEnabled} />
        <MainArea>{children}</MainArea>
      </div>
    </PendingNavProvider>
  );
}
