import type { NextAuthConfig } from "next-auth";

/**
 * The edge-safe half of the NextAuth setup (spec §6, AUTH_MODE=multi).
 *
 * This file must not import anything that needs Node — no Mongo, no node:crypto —
 * because the middleware bundles it to verify the session JWT at the edge. The one
 * thing that *does* need Node, the Credentials provider's password check, lives in
 * lib/nextauth.ts and is added on top of this. That split is the whole reason there
 * are two files: the middleware gets the cheap edge half, the sign-in route gets the
 * full one.
 *
 * The JWT carries only who you are — `uid`. It deliberately does NOT carry the
 * current project or the role. Those are resolved per request against the
 * memberships collection (lib/project.ts), so that removing someone from a project
 * takes effect on their very next request rather than whenever a week-long token
 * happens to be reissued. A token that named the project would be a stale
 * authorization waiting to happen.
 */
export const authConfig = {
  // Self-hosted: there is no trusted proxy list to infer the host from.
  trustHost: true,
  // JWT, not database sessions — the Credentials provider requires it, and it keeps
  // the session read (which happens in edge middleware on every request) off Mongo.
  session: { strategy: "jwt" },
  pages: { signIn: "/login" },
  // Filled in by lib/nextauth.ts with the Credentials provider, which needs Node.
  providers: [],
  callbacks: {
    // On sign-in `user` is present; copy its id onto the token. Pure field-shuffling,
    // so it stays edge-safe.
    jwt({ token, user }) {
      if (user?.id) token.uid = user.id;
      return token;
    },
    // Expose the id on the session object server components read.
    session({ session, token }) {
      if (token.uid && session.user) session.user.id = token.uid as string;
      return session;
    },
  },
} satisfies NextAuthConfig;

export default authConfig;
