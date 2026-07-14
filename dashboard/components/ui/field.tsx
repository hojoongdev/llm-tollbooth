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

/** The same control, for a choice out of a fixed set. Native <select>: it needs no
 *  client state, and the platform already knows how to render a list on a phone. */
export function SelectField({
  label,
  hint,
  className,
  children,
  ...props
}: { label: string; hint?: string } & React.ComponentProps<"select">) {
  return (
    <label className={cn("flex flex-col gap-1 text-xs font-medium", className)}>
      <span className="text-muted-foreground">{label}</span>
      <select className={cn(INPUT, "cursor-pointer pr-1.5")} {...props}>
        {children}
      </select>
      {hint ? <span className="font-normal text-[11px] text-muted-foreground">{hint}</span> : null}
    </label>
  );
}
