/**
 * Offline fallback, precached by the service worker.
 *
 * Deliberately static and self-explanatory: it is served precisely when the
 * network is unavailable, so it cannot fetch anything or show live data.
 */
export default function OfflinePage() {
  return (
    <main
      style={{
        minHeight: '100dvh',
        display: 'grid',
        placeItems: 'center',
        padding: 24,
        textAlign: 'center',
        fontFamily: "'IBM Plex Sans', system-ui, sans-serif",
        background: '#f7f9fb',
        color: '#141a23',
      }}
    >
      <div style={{ maxWidth: 360 }}>
        <div
          style={{
            width: 56,
            height: 56,
            borderRadius: 14,
            background: '#e6eff5',
            margin: '0 auto 20px',
            display: 'grid',
            placeItems: 'center',
            fontSize: 26,
          }}
          aria-hidden="true"
        >
          ⚡
        </div>
        <h1 style={{ margin: '0 0 10px', fontSize: 22, fontWeight: 600 }}>You are offline</h1>
        <p style={{ margin: 0, fontSize: 14, lineHeight: 1.6, color: '#4d5965' }}>
          Shuttle positions and arrival times need a live connection, so there is nothing reliable to
          show while you are disconnected. This page will work again as soon as you are back on the
          company network.
        </p>
        <p style={{ margin: '20px 0 0', fontSize: 13, color: '#677482' }}>
          Any pickup you already requested is unaffected — the driver still has it.
        </p>
      </div>
    </main>
  );
}
