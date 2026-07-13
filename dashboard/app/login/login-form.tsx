"use client";

import { useActionState } from "react";

import { BUTTON, INPUT } from "@/components/ui/controls";
import { login, type LoginState } from "./actions";

export function LoginForm() {
  const [state, action, pending] = useActionState<LoginState, FormData>(login, {});
  return (
    <form action={action} className="flex flex-col gap-3">
      <label className="flex flex-col gap-1 text-xs font-medium">
        <span className="text-muted-foreground">Email</span>
        <input name="email" type="email" autoComplete="username" required autoFocus className={INPUT} />
      </label>
      <label className="flex flex-col gap-1 text-xs font-medium">
        <span className="text-muted-foreground">Password</span>
        <input name="password" type="password" autoComplete="current-password" required className={INPUT} />
      </label>
      {state.error ? <p className="text-xs text-destructive">{state.error}</p> : null}
      <button type="submit" disabled={pending} className={`mt-1 ${BUTTON}`}>
        {pending ? "Signing in…" : "Sign in"}
      </button>
    </form>
  );
}
