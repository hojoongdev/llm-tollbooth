"use server";

import { AuthError } from "next-auth";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";

import { AUTH_MODE, SESSION_COOKIE, SESSION_MAX_AGE, createToken, credentialsValid } from "@/lib/auth";
import { signIn, signOut } from "@/lib/nextauth";

export interface LoginState {
  error?: string;
}

/** single mode — the env-credential HMAC session from P2. Unchanged. */
export async function login(_prev: LoginState, formData: FormData): Promise<LoginState> {
  if (AUTH_MODE !== "single") redirect("/");

  const email = String(formData.get("email") ?? "");
  const password = String(formData.get("password") ?? "");
  if (!credentialsValid(email, password)) {
    return { error: "Invalid email or password." };
  }

  const jar = await cookies();
  jar.set(SESSION_COOKIE, await createToken(email), {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    maxAge: SESSION_MAX_AGE,
    // Only mark Secure when actually served over HTTPS, so login still works on
    // a plain-HTTP self-hosted deployment (localhost / LAN).
    secure: process.env.COOKIE_SECURE === "true",
  });
  redirect("/");
}

/** multi mode — a real account, verified by NextAuth's Credentials provider. */
export async function loginMulti(_prev: LoginState, formData: FormData): Promise<LoginState> {
  if (AUTH_MODE !== "multi") redirect("/");

  try {
    await signIn("credentials", {
      email: String(formData.get("email") ?? ""),
      password: String(formData.get("password") ?? ""),
      redirectTo: "/",
    });
  } catch (err) {
    // signIn throws a redirect on success — that must propagate. Only a genuine
    // auth failure is an AuthError, and only that becomes a message.
    if (err instanceof AuthError) return { error: "Invalid email or password." };
    throw err;
  }
  return {};
}

/** Logout, whichever session the mode uses. */
export async function logout(): Promise<void> {
  if (AUTH_MODE === "multi") {
    await signOut({ redirectTo: "/login" });
    return;
  }
  (await cookies()).delete(SESSION_COOKIE);
  redirect("/login");
}
