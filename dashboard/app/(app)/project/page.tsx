import { redirect } from "next/navigation";

import { projectMembers } from "@/lib/accounts";
import { AUTH_MODE } from "@/lib/auth";
import { currentProject, currentUserId } from "@/lib/project";
import { AddMemberForm } from "@/components/AddMemberForm";
import { NewProjectForm } from "@/components/NewProjectForm";
import { PageBody, PageHeader } from "@/components/page-header";
import { Badge } from "@/components/ui/badge";
import { BUTTON_QUIET } from "@/components/ui/controls";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { changeRole, kickMember } from "./actions";

export const dynamic = "force-dynamic";

/**
 * The tenant screen (spec §4 group E): who is in this project, and — for an owner —
 * adding, promoting and removing them, plus spinning up another project.
 *
 * Only exists in multi mode. none has no tenancy and single has exactly one operator,
 * so there is nothing here to manage.
 */
export default async function ProjectPage() {
  if (AUTH_MODE !== "multi") redirect("/");

  const project = await currentProject();
  const [members, uid] = await Promise.all([projectMembers(project.id), currentUserId()]);
  const isOwner = project.role === "owner";

  return (
    <>
      <PageHeader title="Project" description={project.name} />

      <PageBody>
        <Card>
          <CardHeader>
            <CardTitle>Members</CardTitle>
          </CardHeader>
          <CardContent>
            <ul className="divide-y divide-border">
              {members.map((m) => (
                <li key={m.id} className="flex flex-wrap items-center gap-3 py-3 first:pt-0 last:pb-0">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium">{m.name}</span>
                      {m.id === uid ? <span className="text-[11px] text-muted-foreground">(you)</span> : null}
                    </div>
                    <div className="font-mono text-[11px] text-muted-foreground">{m.email}</div>
                  </div>

                  <Badge variant={m.role === "owner" ? "default" : "muted"} className="ml-auto">
                    {m.role}
                  </Badge>

                  {/* Owner-only controls. The server re-checks the role and the
                      last-owner guard regardless of what the UI shows. */}
                  {isOwner ? (
                    <div className="flex items-center gap-1">
                      <form action={changeRole}>
                        <input type="hidden" name="user_id" value={m.id} />
                        <input type="hidden" name="role" value={m.role === "owner" ? "member" : "owner"} />
                        <button type="submit" className={BUTTON_QUIET}>
                          {m.role === "owner" ? "→ member" : "→ owner"}
                        </button>
                      </form>
                      <form action={kickMember}>
                        <input type="hidden" name="user_id" value={m.id} />
                        <button type="submit" className={`${BUTTON_QUIET} text-destructive`}>
                          remove
                        </button>
                      </form>
                    </div>
                  ) : null}
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>

        {isOwner ? (
          <Card>
            <CardHeader>
              <CardTitle>Add a member</CardTitle>
            </CardHeader>
            <CardContent>
              <AddMemberForm />
            </CardContent>
          </Card>
        ) : (
          <p className="text-[11px] text-muted-foreground">
            멤버 관리는 owner 만 할 수 있습니다. 지금 역할은 <span className="font-mono">member</span> 입니다.
          </p>
        )}

        <Card>
          <CardHeader>
            <CardTitle>New project</CardTitle>
          </CardHeader>
          <CardContent>
            <NewProjectForm />
            <p className="mt-3 text-[11px] leading-relaxed text-muted-foreground">
              새 프로젝트를 만들면 곧바로 그 프로젝트로 전환되고, 당신이 첫 owner 가 됩니다. 사이드바에서 언제든
              프로젝트를 바꿀 수 있습니다.
            </p>
          </CardContent>
        </Card>
      </PageBody>
    </>
  );
}
