"use client";

import Link from "next/link";
import { useActionState } from "react";

import { BUTTON, INPUT } from "@/components/ui/controls";
import { loginMulti, type LoginState } from "./actions";

export function MultiLoginForm() {
  const [state, action, pending] = useActionState<LoginState, FormData>(loginMulti, {});
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
      <p className="mt-1 text-center text-xs text-muted-foreground">
        계정이 없나요?{" "}
        <Link href="/signup" className="text-foreground underline underline-offset-2">
          가입
        </Link>
      </p>
    </form>
  );
}
