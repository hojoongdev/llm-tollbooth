import NextAuth from "next-auth";
import { NextResponse, type NextRequest } from "next/server";

import { AUTH_MODE, SESSION_COOKIE, verifyToken } from "@/lib/auth";
import { authConfig } from "@/lib/auth.config";

/**
 * One gate, three modes (spec §6). The mode switch lives here and nowhere else.
 *
 *   none    — the console is open; wave everything through.
 *   single  — the HMAC cookie session from P2, verified with Web Crypto.
 *   multi   — a NextAuth session, verified from its JWT at the edge.
 *
 * NextAuth is only constructed for multi mode's guard, so none and single need no
 * AUTH_SECRET and pull in none of its machinery on the request path.
 */
const { auth } = NextAuth(authConfig);

const toLogin = (req: NextRequest) => {
  const url = req.nextUrl.clone();
  url.pathname = "/login";
  url.search = "";
  return NextResponse.redirect(url);
};

// NextAuth decodes its session into req.auth; we decide what to do with it.
const guardMulti = auth((req) => (req.auth ? NextResponse.next() : toLogin(req)));

export default async function middleware(req: NextRequest, ev: never) {
  if (AUTH_MODE === "none") return NextResponse.next();

  if (AUTH_MODE === "single") {
    const token = req.cookies.get(SESSION_COOKIE)?.value;
    return (await verifyToken(token)) ? NextResponse.next() : toLogin(req);
  }

  // multi
  return guardMulti(req as never, ev);
}

export const config = {
  // Guard everything except the auth surfaces (login, signup, NextAuth's own
  // /api/auth/* endpoints) and Next's static assets. Guarding /api/auth would lock
  // the door and throw away the key.
  matcher: ["/((?!login|signup|api/auth|_next/static|_next/image|favicon.ico).*)"],
};
