import { TrafficCone } from "lucide-react";
import { redirect } from "next/navigation";

import { AUTH_MODE } from "@/lib/auth";
import { SignupForm } from "./signup-form";

export const dynamic = "force-dynamic";

export default function SignupPage() {
  // Sign-up only exists in multi mode — none has no accounts, single has exactly one
  // and it comes from env, not a form.
  if (AUTH_MODE !== "multi") redirect("/login");

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
        <h1 className="text-base font-semibold tracking-tight">Create your account</h1>
        <p className="mb-4 mt-0.5 text-xs text-muted-foreground">가입하면 첫 프로젝트가 함께 만들어집니다.</p>
        <SignupForm />
      </div>
    </div>
  );
}
