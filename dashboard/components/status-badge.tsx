import { Badge } from "./ui/badge";

type Variant = "success" | "destructive" | "info" | "warning" | "muted";

export function StatusBadge({ status, cacheHit }: { status: string; cacheHit?: boolean }) {
  if (cacheHit && status === "success") return <Badge variant="info">cached</Badge>;
  const variant: Variant =
    status === "success"
      ? "success"
      : status === "error"
        ? "destructive"
        : status === "cached"
          ? "info"
          : status === "blocked"
            ? "warning"
            : "muted";
  return <Badge variant={variant}>{status}</Badge>;
}
