import type { ReactNode } from "react";

export function CommandPanel({
  title,
  eyebrow,
  actions,
  children,
  wide = false
}: {
  title: string;
  eyebrow?: string;
  actions?: ReactNode;
  children: ReactNode;
  wide?: boolean;
}) {
  return (
    <section className={`command-panel${wide ? " wide" : ""}`}>
      <div className="panel-sweep" aria-hidden="true" />
      <header className="panel-header">
        <div>
          {eyebrow ? <p className="panel-eyebrow">{eyebrow}</p> : null}
          <h2>{title}</h2>
          <span className="panel-index-code" aria-hidden="true">
            {title}
          </span>
        </div>
        {actions ? <div className="panel-actions">{actions}</div> : null}
      </header>
      {children}
    </section>
  );
}
