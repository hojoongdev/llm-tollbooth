"use server";

import { AuthError } from "next-auth";
import { redirect } from "next/navigation";

import { createUser } from "@/lib/accounts";
import { AUTH_MODE } from "@/lib/auth";
import { signIn } from "@/lib/nextauth";

export interface SignupState {
  error?: string;
}

/**
 * Register an account, then sign it in — one continuous motion, because a signup
 * that dumped you back on the login page to type it all again would be a small
 * cruelty. createUser also creates the person's first project (accounts.ts), so
 * they land somewhere real.
 */
export async function signup(_prev: SignupState, formData: FormData): Promise<SignupState> {
  if (AUTH_MODE !== "multi") redirect("/");

  const email = String(formData.get("email") ?? "").trim();
  const password = String(formData.get("password") ?? "");
  const name = String(formData.get("name") ?? "").trim();

  if (!email || !email.includes("@")) return { error: "Enter a valid email address." };
  // Not a policy engine — just a floor. A one-character password is a mistake, not a choice.
  if (password.length < 8) return { error: "Use a password of at least 8 characters." };

  try {
    await createUser(email, password, name);
  } catch (err) {
    // The unique index on email is the real guard; this turns its violation into a
    // sentence. Any other failure is ours, and should surface as a 500, not a login hint.
    const msg = err instanceof Error ? err.message : "";
    if (msg.includes("already registered") || msg.includes("duplicate key")) {
      return { error: "That email is already registered — sign in instead." };
    }
    throw err;
  }

  try {
    await signIn("credentials", { email, password, redirectTo: "/" });
  } catch (err) {
    if (err instanceof AuthError) {
      // The account exists; only the auto-login hiccuped. Send them to sign in by hand.
      redirect("/login");
    }
    throw err;
  }
  return {};
}
