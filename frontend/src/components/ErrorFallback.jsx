export default function ErrorFallback() {
  return (
    <main className="boot">
      <img src="/brand/vibhavgpt-icon-64.png" alt="" />
      <div className="empty-state" style={{ border: 0 }}>
        <strong>Something went wrong</strong>
        <p>Refresh the page to get back to your workspace.</p>
      </div>
      <button className="btn btn--primary" onClick={() => window.location.reload()}>
        Refresh
      </button>
    </main>
  );
}
