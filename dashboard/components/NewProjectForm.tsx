"use client";

import { useActionState } from "react";
import { FolderPlus } from "lucide-react";

import { newProject, type MemberState } from "@/app/(app)/project/actions";
import { BUTTON } from "@/components/ui/controls";
import { Field } from "@/components/ui/field";

export function NewProjectForm() {
  const [state, action, pending] = useActionState<MemberState, FormData>(newProject, {});
  return (
    <form action={action} className="flex flex-wrap items-end gap-3">
      <Field label="새 프로젝트 이름" name="name" required placeholder="staging" className="min-w-56 flex-1" />
      <button type="submit" disabled={pending} className={BUTTON}>
        <FolderPlus className="h-3.5 w-3.5" strokeWidth={2} />
        {pending ? "만드는 중…" : "프로젝트 생성"}
      </button>
      {state.error ? <p className="w-full text-xs text-destructive">{state.error}</p> : null}
    </form>
  );
}
