import { TrafficCone } from "lucide-react";
import { redirect } from "next/navigation";

import { AUTH_MODE } from "@/lib/auth";
import { LoginForm } from "./login-form";

export const dynamic = "force-dynamic";

export default function LoginPage() {
  // Nothing to log into when the console is open.
  if (AUTH_MODE !== "single") redirect("/");

  return (
    <div className="flex min-h-svh items-center justify-center p-6">
      <div className="w-full max-w-xs rounded-lg border border-border bg-card p-6">
        <div className="mb-5 flex items-center gap-2">
          <TrafficCone className="h-5 w-5 text-primary" strokeWidth={2} />
          <div className="flex flex-col leading-none">
            <span className="text-sm font-semibold tracking-tight">Tollbooth</span>
            <span className="text-[10px] uppercase tracking-wider text-muted-foreground">console</span>
          </div>
        </div>
        <h1 className="text-base font-semibold tracking-tight">Sign in</h1>
        <p className="mb-4 mt-0.5 text-xs text-muted-foreground">이 콘솔은 로그인이 필요합니다.</p>
        <LoginForm />
      </div>
    </div>
  );
}
