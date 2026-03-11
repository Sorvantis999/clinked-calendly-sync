export default function Home() {
  return (
    <main style={{ fontFamily: 'system-ui', padding: '2rem', maxWidth: 600 }}>
      <h1>Clinked ↔ Calendly Sync</h1>
      <p>Webhook endpoint active at <code>/api/webhooks/calendly</code></p>
      <p>Status: <strong style={{ color: 'green' }}>Active</strong></p>
    </main>
  );
}
