"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";

import { AUTH_MODE, SESSION_COOKIE, SESSION_MAX_AGE, createToken, credentialsValid } from "@/lib/auth";

export interface LoginState {
  error?: string;
}

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

export async function logout(): Promise<void> {
  (await cookies()).delete(SESSION_COOKIE);
  redirect("/login");
}
