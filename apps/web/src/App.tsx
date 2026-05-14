const apiBaseUrl = import.meta.env.VITE_API_BASE_URL ?? "same-origin";

export function App() {
  return (
    <main className="app-shell">
      <section className="status-panel" aria-labelledby="app-title">
        <p className="eyebrow">Phase 0 smoke-test shell</p>
        <h1 id="app-title">Arma Attendance Tracker</h1>
        <div className="status-grid">
          <div>
            <span>API</span>
            <strong>ready for /health and /v1/debug/poke</strong>
          </div>
          <div>
            <span>Target</span>
            <strong>{apiBaseUrl}</strong>
          </div>
          <div>
            <span>Version</span>
            <strong>0.1.0</strong>
          </div>
        </div>
      </section>
    </main>
  );
}
