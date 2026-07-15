"use client";

import { useActionState } from "react";
import { UserPlus } from "lucide-react";

import { addMember, type MemberState } from "@/app/(app)/project/actions";
import { BUTTON } from "@/components/ui/controls";
import { Field, SelectField } from "@/components/ui/field";

export function AddMemberForm() {
  const [state, action, pending] = useActionState<MemberState, FormData>(addMember, {});
  return (
    <form action={action} className="flex flex-col gap-3">
      <div className="flex flex-wrap items-end gap-3">
        <Field
          label="이메일 (가입된 사용자)"
          name="email"
          type="email"
          required
          placeholder="teammate@example.com"
          className="min-w-56 flex-1"
        />
        <SelectField label="역할" name="role" defaultValue="member" className="w-32">
          <option value="member">Member</option>
          <option value="owner">Owner</option>
        </SelectField>
        <button type="submit" disabled={pending} className={BUTTON}>
          <UserPlus className="h-3.5 w-3.5" strokeWidth={2} />
          {pending ? "추가 중…" : "멤버 추가"}
        </button>
      </div>
      {state.error ? <p className="text-xs text-destructive">{state.error}</p> : null}
      {state.ok ? <p className="text-xs text-success">{state.ok}</p> : null}
      <p className="text-[11px] leading-relaxed text-muted-foreground">
        초대는 <strong className="font-medium">이미 가입한 사용자</strong>를 이메일로 추가하는 방식입니다 — 셀프호스팅
        콘솔이라 초대 메일을 보내지 않습니다. 상대가 먼저 가입한 뒤 여기서 추가하세요.
      </p>
    </form>
  );
}
