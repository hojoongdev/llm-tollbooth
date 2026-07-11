import { NextResponse, type NextRequest } from "next/server";

import { AUTH_MODE, SESSION_COOKIE, verifyToken } from "@/lib/auth";

export async function middleware(req: NextRequest) {
  if (AUTH_MODE !== "single") return NextResponse.next();

  const token = req.cookies.get(SESSION_COOKIE)?.value;
  if (await verifyToken(token)) return NextResponse.next();

  const url = req.nextUrl.clone();
  url.pathname = "/login";
  url.search = "";
  return NextResponse.redirect(url);
}

export const config = {
  // Guard everything except the login page and Next's own assets.
  matcher: ["/((?!login|_next/static|_next/image|favicon.ico).*)"],
};
