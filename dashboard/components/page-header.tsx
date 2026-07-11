// Sticky page header on the card surface, separated from the scrolling body by a
// border — the top stays put as you move between screens.
export function PageHeader({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children?: React.ReactNode;
}) {
  return (
    <header className="sticky top-12 z-20 flex shrink-0 items-center gap-3 border-b border-border bg-card px-6 py-3 md:top-0">
      <div className="flex min-w-0 flex-col leading-tight">
        <h1 className="text-base font-semibold tracking-tight">{title}</h1>
        {description ? <p className="text-xs text-muted-foreground">{description}</p> : null}
      </div>
      {children ? <div className="ml-auto flex items-center gap-2">{children}</div> : null}
    </header>
  );
}

export function PageBody({ children }: { children: React.ReactNode }) {
  return (
    <div className="p-6">
      <div className="mx-auto flex max-w-6xl flex-col gap-4">{children}</div>
    </div>
  );
}
