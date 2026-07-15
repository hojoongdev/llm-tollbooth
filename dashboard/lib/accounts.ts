import "server-only";
import { randomBytes, randomUUID, scrypt, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

import { db } from "./mongo";

/**
 * The account layer that turns the single-tenant stack into a multi-tenant one
 * (spec §4 group E, AUTH_MODE=multi). Three collections, and one boundary:
 *
 *   users        who can log in — email + a password hash, nothing more.
 *   projects     the tenant. A project *is* the isolation boundary: every request,
 *                key, rule and metric already carries a project_id (it always has —
 *                the Cassandra partition key has led with it since P2), and until
 *                now that id was the constant "default". Multi mode makes it real.
 *   memberships  who may see which project, and as what (owner | member). Kept as
 *                its own collection rather than an array on either side, because the
 *                question asked on every single request — "is this user in this
 *                project, and what is their role" — is then one indexed lookup.
 *
 * What is deliberately NOT here: the current project. That is not a property of the
 * user (they may belong to several) — it is a property of the *session*, resolved
 * per request against these memberships. See lib/project.ts. Keeping it out of the
 * account record is what lets a revoked membership take effect on the very next
 * request instead of whenever a token happens to refresh.
 */

const scryptAsync = promisify(scrypt);

// --------------------------------------------------------------------------- //
// Passwords
// --------------------------------------------------------------------------- //
// scrypt, not the SHA-256 the API keys use — and the difference is the whole
// point. An API key is 24 bytes of entropy with nothing to guess; a password is
// low-entropy and human-chosen, so the hash has to be *slow* to make guessing it
// expensive. scrypt is memory-hard and in Node's standard library, so this costs
// no dependency. Salt per password, stored alongside; compared in constant time.
const SCRYPT_KEYLEN = 64;

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const derived = (await scryptAsync(password, salt, SCRYPT_KEYLEN)) as Buffer;
  return `scrypt$${salt.toString("hex")}$${derived.toString("hex")}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, saltHex, hashHex] = stored.split("$");
  if (scheme !== "scrypt" || !saltHex || !hashHex) return false;
  const derived = (await scryptAsync(password, Buffer.from(saltHex, "hex"), SCRYPT_KEYLEN)) as Buffer;
  const expected = Buffer.from(hashHex, "hex");
  // timingSafeEqual throws on a length mismatch, which would itself leak; guard it.
  return derived.length === expected.length && timingSafeEqual(derived, expected);
}

// --------------------------------------------------------------------------- //
// Types
// --------------------------------------------------------------------------- //
export type Role = "owner" | "member";

export interface User {
  id: string;
  email: string;
  name: string;
}

export interface Project {
  id: string;
  name: string;
  createdAt: Date;
}

export interface Membership {
  projectId: string;
  projectName: string;
  role: Role;
}

// --------------------------------------------------------------------------- //
// Collections + indexes
// --------------------------------------------------------------------------- //
const users = () => db().collection("users");
const projects = () => db().collection("projects");
const memberships = () => db().collection("memberships");

// The dashboard owns these three collections, so — as everywhere else in this
// project — it is the thing that guarantees their indexes (gateway/src/keys.ts
// makes the same argument). Ensured once per process, lazily, guarded by a promise
// so concurrent callers share the one round-trip.
let ensured: Promise<void> | null = null;
export function ensureAccountIndexes(): Promise<void> {
  if (!ensured) {
    ensured = (async () => {
      await users().createIndex({ email: 1 }, { unique: true });
      // The hot lookup: "is this user in this project" (project.ts, every request).
      await memberships().createIndex({ user_id: 1, project_id: 1 }, { unique: true });
      await memberships().createIndex({ project_id: 1 });
    })().catch((err) => {
      // Don't cache a failure — let the next call retry rather than wedge the app.
      ensured = null;
      throw err;
    });
  }
  return ensured;
}

// --------------------------------------------------------------------------- //
// Users
// --------------------------------------------------------------------------- //
function toUser(d: Record<string, any>): User {
  return { id: String(d._id), email: d.email, name: d.name ?? d.email };
}

export async function findUserByEmail(email: string): Promise<(User & { passwordHash: string }) | null> {
  await ensureAccountIndexes();
  const d = await users().findOne({ email: email.toLowerCase().trim() });
  return d ? { ...toUser(d), passwordHash: d.password_hash } : null;
}

export async function findUserById(id: string): Promise<User | null> {
  const d = await users().findOne({ _id: id as never });
  return d ? toUser(d) : null;
}

/**
 * Register a user and give them a project to land in — atomically enough that a
 * half-made account (a user with nowhere to go, or a project with no owner) can't
 * survive a crash between the two writes. A brand-new account with no project would
 * log in to a dead end, so signup makes both.
 */
export async function createUser(email: string, password: string, name: string): Promise<User> {
  await ensureAccountIndexes();
  const normalized = email.toLowerCase().trim();
  const userId = `usr_${randomBytes(6).toString("hex")}`;

  // Unique index on email is the real guard against a race; this is the friendly
  // early check. Both matter — the index is truth, the check is the message.
  if (await users().findOne({ email: normalized })) {
    throw new Error("That email is already registered.");
  }

  await users().insertOne({
    _id: userId as never,
    email: normalized,
    name: name.trim() || normalized,
    password_hash: await hashPassword(password),
    created_at: new Date(),
  });

  await createProject(userId, `${name.trim() || "My"}'s project`);
  return { id: userId, email: normalized, name: name.trim() || normalized };
}

// --------------------------------------------------------------------------- //
// Projects + memberships
// --------------------------------------------------------------------------- //
/** Create a project and make its creator the owner — the two writes that must both
 *  land, or neither is useful. */
export async function createProject(ownerId: string, name: string): Promise<Project> {
  await ensureAccountIndexes();
  const id = `prj_${randomBytes(6).toString("hex")}`;
  const createdAt = new Date();
  await projects().insertOne({ _id: id as never, name: name.trim() || "Untitled project", created_at: createdAt });
  await memberships().insertOne({
    _id: randomUUID() as never,
    user_id: ownerId,
    project_id: id,
    role: "owner",
    created_at: createdAt,
  });
  return { id, name: name.trim() || "Untitled project", createdAt };
}

/** The projects a user belongs to, with their role in each — the switcher's list,
 *  and the set every isolation check validates against. */
export async function membershipsOf(userId: string): Promise<Membership[]> {
  const rows = await memberships().find({ user_id: userId }).toArray();
  if (rows.length === 0) return [];
  const byId = new Map(rows.map((r) => [String(r.project_id), r]));
  const projDocs = await projects().find({ _id: { $in: [...byId.keys()] as never[] } }).toArray();
  const names = new Map(projDocs.map((p) => [String(p._id), p.name as string]));
  return rows
    .map((r) => ({
      projectId: String(r.project_id),
      projectName: names.get(String(r.project_id)) ?? "(deleted project)",
      role: (r.role === "owner" ? "owner" : "member") as Role,
    }))
    .sort((a, b) => a.projectName.localeCompare(b.projectName));
}

/**
 * The one function isolation actually rests on: is this user in this project, and
 * as what? Returns null if not a member — and null has to mean *denied*, at every
 * call site, or the whole boundary is decorative.
 */
export async function membershipFor(userId: string, projectId: string): Promise<Membership | null> {
  const r = await memberships().findOne({ user_id: userId, project_id: projectId });
  if (!r) return null;
  const p = await projects().findOne({ _id: projectId as never });
  return {
    projectId,
    projectName: (p?.name as string) ?? "(deleted project)",
    role: r.role === "owner" ? "owner" : "member",
  };
}

export async function projectMembers(projectId: string): Promise<Array<User & { role: Role }>> {
  const rows = await memberships().find({ project_id: projectId }).toArray();
  const userDocs = await users().find({ _id: { $in: rows.map((r) => r.user_id) as never[] } }).toArray();
  const byId = new Map(userDocs.map((u) => [String(u._id), toUser(u)]));
  return rows
    .map((r) => {
      const u = byId.get(String(r.user_id));
      return u ? { ...u, role: (r.role === "owner" ? "owner" : "member") as Role } : null;
    })
    .filter((x): x is User & { role: Role } => x !== null);
}
