// Single-tenant until P6: everything reads the one "default" project.
export const PROJECT = process.env.PROJECT_ID || "default";

/**
 * Environment the Settings screen reports on, rather than edits (spec §8 screen 6).
 *
 * These are read-only there on purpose, and the line is not arbitrary: a value the console
 * can change is one that lives in a database and is re-read by whoever obeys it (the eval
 * settings work exactly that way). These live in the env of processes that read them once,
 * at boot — so a console that offered to edit them could only ever pretend to.
 *
 * The SMTP values are the *rules worker's*, passed to the console for display so it can show
 * what alerts will actually do. Showing them requires compose to hand them over; inventing
 * them from the documented defaults would be a screen that is right until someone changes
 * their .env, and then confidently wrong.
 */
export const AUTH_MODE = process.env.AUTH_MODE || "none";
export const SMTP_HOST = process.env.SMTP_HOST || "mailpit";
export const SMTP_PORT = process.env.SMTP_PORT || "1025";
export const SMTP_FROM = process.env.SMTP_FROM || "alerts@tollbooth.local";
/** Empty = no global fallback. A key can still name its own (API Keys screen). */
export const FALLBACK_MODEL = process.env.GATEWAY_FALLBACK_MODEL || "";
