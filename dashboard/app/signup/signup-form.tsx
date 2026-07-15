"use client";

import Link from "next/link";
import { useActionState } from "react";

import { BUTTON, INPUT } from "@/components/ui/controls";
import { signup, type SignupState } from "./actions";

export function SignupForm() {
  const [state, action, pending] = useActionState<SignupState, FormData>(signup, {});
  return (
    <form action={action} className="flex flex-col gap-3">
      <label className="flex flex-col gap-1 text-xs font-medium">
        <span className="text-muted-foreground">Name</span>
        <input name="name" type="text" autoComplete="name" required autoFocus className={INPUT} />
      </label>
      <label className="flex flex-col gap-1 text-xs font-medium">
        <span className="text-muted-foreground">Email</span>
        <input name="email" type="email" autoComplete="username" required className={INPUT} />
      </label>
      <label className="flex flex-col gap-1 text-xs font-medium">
        <span className="text-muted-foreground">Password</span>
        <input name="password" type="password" autoComplete="new-password" required minLength={8} className={INPUT} />
      </label>
      {state.error ? <p className="text-xs text-destructive">{state.error}</p> : null}
      <button type="submit" disabled={pending} className={`mt-1 ${BUTTON}`}>
        {pending ? "Creating…" : "Create account"}
      </button>
      <p className="mt-1 text-center text-xs text-muted-foreground">
        이미 계정이 있나요?{" "}
        <Link href="/login" className="text-foreground underline underline-offset-2">
          로그인
        </Link>
      </p>
    </form>
  );
}
