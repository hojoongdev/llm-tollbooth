import type { DefaultSession } from "next-auth";

// The session/JWT carry a user id we put there in the callbacks (lib/auth.config.ts).
// Without this augmentation `session.user.id` and `token.uid` are type errors.
declare module "next-auth" {
  interface Session {
    user: { id: string } & DefaultSession["user"];
  }
}

declare module "next-auth/jwt" {
  interface JWT {
    uid?: string;
  }
}
