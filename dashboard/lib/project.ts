import "server-only";
import { cookies } from "next/headers";

import { membershipFor, membershipsOf, type Role } from "./accounts";
import { AUTH_MODE } from "./auth";
import { PROJECT } from "./config";
import { auth } from "./nextauth";

/**
 * Which tenant this request belongs to — the value every isolated read is scoped by
 * (spec §4 group E). This is the seam the whole boundary hangs on: get it right here,
 * once, and every data function that takes its result is safe; get it wrong and no
 * amount of care downstream matters.
 *
 * The current project is a property of the *session*, not the account. A user may
 * belong to several, and which one they are looking at is a cookie they can change —
 * but the cookie is never trusted on its own. Every resolution re-checks membership
 * against Mongo, so a cookie pointing at a project the user was removed from resolves
 * to a project they are still in, not to the one they were kicked out of. That
 * re-check is why removing someone takes effect on their very next request.
 *
 * In none/single mode there is no session and no tenancy: everything is the one env
 * project, exactly as it was before P6. So the same pages call currentProject()
 * whatever the mode, and only multi does any work.
 */

export const PROJECT_COOKIE = "tb_project";

export interface CurrentProject {
  id: string;
  name: string;
  role: Role;
}

/** Resolve the caller's active project, or throw if a multi-mode request somehow has
 *  no session or the user has no projects (both of which the middleware and signup
 *  make impossible in the normal flow — a throw here is a bug, not a user state). */
export async function currentProject(): Promise<CurrentProject> {
  if (AUTH_MODE !== "multi") {
    return { id: PROJECT, name: PROJECT, role: "owner" };
  }

  const session = await auth();
  const uid = session?.user?.id;
  if (!uid) throw new Error("currentProject called without a session in multi mode");

  const jar = await cookies();
  const wanted = jar.get(PROJECT_COOKIE)?.value;
  if (wanted) {
    const m = await membershipFor(uid, wanted);
    // The cookie is only honoured if it still names a project they belong to.
    if (m) return { id: m.projectId, name: m.projectName, role: m.role };
  }

  // No selection, or a stale one: land them in a project they are actually in.
  const all = await membershipsOf(uid);
  if (all.length === 0) throw new Error(`user ${uid} belongs to no project`);
  const first = all[0];
  return { id: first.projectId, name: first.projectName, role: first.role };
}

/** The projects the current user can switch between — the switcher's list. Empty in
 *  none/single mode, where there is nothing to switch. */
export async function switchableProjects(): Promise<{ id: string; name: string; role: Role }[]> {
  if (AUTH_MODE !== "multi") return [];
  const session = await auth();
  const uid = session?.user?.id;
  if (!uid) return [];
  return (await membershipsOf(uid)).map((m) => ({ id: m.projectId, name: m.projectName, role: m.role }));
}
