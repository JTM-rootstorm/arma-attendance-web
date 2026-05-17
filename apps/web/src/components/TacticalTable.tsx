import type { CSSProperties, ReactNode } from "react";

export function TacticalTable({
  children,
  label,
  maxVisibleRows = 12,
  className = ""
}: {
  children: ReactNode;
  label: string;
  maxVisibleRows?: number;
  className?: string;
}) {
  return (
    <div
      className={`tactical-table ${className}`.trim()}
      aria-label={label}
      style={{ "--table-visible-rows": maxVisibleRows } as CSSProperties}
    >
      <table>{children}</table>
    </div>
  );
}
