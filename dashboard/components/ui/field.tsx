import { cn } from "@/lib/utils";
import { INPUT } from "./controls";

export function Field({
  label,
  hint,
  className,
  ...props
}: { label: string; hint?: string } & React.ComponentProps<"input">) {
  return (
    <label className={cn("flex flex-col gap-1 text-xs font-medium", className)}>
      <span className="text-muted-foreground">{label}</span>
      <input className={INPUT} {...props} />
      {hint ? <span className="font-normal text-[11px] text-muted-foreground">{hint}</span> : null}
    </label>
  );
}
