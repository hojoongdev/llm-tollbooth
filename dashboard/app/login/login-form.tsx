"use client";

import { useActionState } from "react";

import { login, type LoginState } from "./actions";

const INPUT =
  "h-8 rounded-md border border-border bg-background px-2.5 text-sm outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background";

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
      <button
        type="submit"
        disabled={pending}
        className="mt-1 inline-flex h-8 items-center justify-center rounded-md bg-primary px-3 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50"
      >
        {pending ? "Signing in…" : "Sign in"}
      </button>
    </form>
  );
}
