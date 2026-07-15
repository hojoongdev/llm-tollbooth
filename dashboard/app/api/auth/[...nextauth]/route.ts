import { handlers } from "@/lib/nextauth";

// NextAuth's own endpoints (sign-in, sign-out, session, CSRF). Only ever hit in
// AUTH_MODE=multi; none and single never route here.
export const { GET, POST } = handlers;
