import type { ReactNode } from "react";

export function TacticalTable({
  children,
  label
}: {
  children: ReactNode;
  label: string;
}) {
  return (
    <div className="tactical-table" aria-label={label}>
      <table>{children}</table>
    </div>
  );
}
