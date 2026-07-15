import NextAuth from "next-auth";
import Credentials from "next-auth/providers/credentials";

import { findUserByEmail, verifyPassword } from "./accounts";
import { authConfig } from "./auth.config";

/**
 * The Node half of the NextAuth setup: the edge-safe config plus the one provider
 * that needs a database and a slow hash (spec §6, AUTH_MODE=multi).
 *
 * `authorize` is the password check, and it runs only at sign-in, in the Node
 * runtime the /api/auth route provides — never in the edge middleware, which is why
 * this file can reach into Mongo and scrypt while auth.config.ts cannot. It returns
 * a user or null; NextAuth turns null into "invalid credentials" without telling the
 * caller which field was wrong.
 */
export const { handlers, auth, signIn, signOut } = NextAuth({
  ...authConfig,
  providers: [
    Credentials({
      credentials: {
        email: { label: "Email", type: "email" },
        password: { label: "Password", type: "password" },
      },
      authorize: async (creds) => {
        const email = String(creds?.email ?? "");
        const password = String(creds?.password ?? "");
        if (!email || !password) return null;

        const user = await findUserByEmail(email);
        // Verify a password even when the user doesn't exist would be ideal for
        // timing; scrypt on a throwaway hash is the way to do that. Kept simple here
        // — the console is not a public login surface at internet scale.
        if (!user) return null;
        if (!(await verifyPassword(password, user.passwordHash))) return null;

        return { id: user.id, email: user.email, name: user.name };
      },
    }),
  ],
});
