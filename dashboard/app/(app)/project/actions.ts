"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import {
  addMemberByEmail,
  createProject,
  removeMember,
  setMemberRole,
  type Role,
} from "@/lib/accounts";
import { currentProject, currentUserId, setCurrentProject } from "@/lib/project";

export interface MemberState {
  ok?: string;
  error?: string;
}

/** Switch the active project. setCurrentProject refuses a project you're not in, so a
 *  forged id here changes nothing. */
export async function switchProject(form: FormData): Promise<void> {
  await setCurrentProject(String(form.get("project_id") ?? ""));
  redirect("/");
}

/** Create a project and switch into it — the creator is its first owner (accounts.ts). */
export async function newProject(_prev: MemberState, form: FormData): Promise<MemberState> {
  const uid = await currentUserId();
  if (!uid) return { error: "Not signed in." };
  const name = String(form.get("name") ?? "").trim();
  if (!name) return { error: "Give the project a name." };

  const project = await createProject(uid, name);
  await setCurrentProject(project.id);
  redirect("/");
}

/**
 * Member management is owner-only, and the check is here on the server — not merely
 * hidden in the UI. A member who crafted the request by hand still can't add, promote or
 * remove anyone: the action refuses them before touching a thing.
 */
async function requireOwner(): Promise<{ projectId: string } | { error: string }> {
  const { id, role } = await currentProject();
  if (role !== "owner") return { error: "Only an owner can manage members." };
  return { projectId: id };
}

export async function addMember(_prev: MemberState, form: FormData): Promise<MemberState> {
  const ctx = await requireOwner();
  if ("error" in ctx) return ctx;

  const email = String(form.get("email") ?? "").trim();
  const role: Role = form.get("role") === "owner" ? "owner" : "member";
  if (!email) return { error: "Enter the email of a registered user." };

  try {
    const user = await addMemberByEmail(ctx.projectId, email, role);
    revalidatePath("/project");
    return { ok: `Added ${user.name} as ${role}.` };
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Could not add that member." };
  }
}

export async function changeRole(form: FormData): Promise<void> {
  const ctx = await requireOwner();
  if ("error" in ctx) return;
  const userId = String(form.get("user_id") ?? "");
  const role: Role = form.get("role") === "owner" ? "owner" : "member";
  try {
    await setMemberRole(ctx.projectId, userId, role);
  } catch {
    // The last-owner guard threw; the page re-renders with the unchanged roles, which
    // is the honest outcome. (A toast would be nicer; not worth a client round-trip here.)
  }
  revalidatePath("/project");
}

export async function kickMember(form: FormData): Promise<void> {
  const ctx = await requireOwner();
  if ("error" in ctx) return;
  try {
    await removeMember(ctx.projectId, String(form.get("user_id") ?? ""));
  } catch {
    // Last-owner guard; leave the roster as it was.
  }
  revalidatePath("/project");
}
