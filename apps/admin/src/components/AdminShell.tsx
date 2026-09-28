'use client';

import React from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { api, useAuth, useSocket, useSocketEvent } from '@shuttle/client';
import type { Notification } from '@shuttle/shared-types';
import { formatRelativeDay } from '@shuttle/shared-utils';
import {
  Avatar,
  Button,
  LiveDot,
  Logo,
  Mono,
  brand,
  fontSize,
  radius,
  shadow,
  ThemeToggle,
  useTheme,
  weight,
} from '@shuttle/ui';
import { SignIn } from './SignIn';

/** The nine views from the approved design, in their three groups. */
const NAV = [
  {
    group: 'Monitor',
    items: [
      { href: '/', label: 'Live overview' },
      { href: '/requests', label: 'Pickup requests' },
      { href: '/trips', label: 'Trips today' },
    ],
  },
  {
    group: 'Manage',
    items: [
      { href: '/shuttles', label: 'Shuttles' },
      { href: '/drivers', label: 'Drivers' },
      { href: '/employees', label: 'Employees' },
      { href: '/stops', label: 'Stops & routes' },
    ],
  },
  {
    group: 'Insights',
    items: [
      { href: '/reports', label: 'Reports' },
      { href: '/settings', label: 'Settings' },
    ],
  },
] as const;

export function AdminShell({
  title,
  section,
  actions,
  children,
  /** Badge counts keyed by nav href, e.g. { '/requests': 4 }. */
  badges,
}: {
  title: string;
  section: string;
  actions?: React.ReactNode;
  children: React.ReactNode;
  badges?: Record<string, number | undefined>;
}) {
  const { status, session, signOut, role } = useAuth();
  const { connected } = useSocket();
  const { theme } = useTheme();
  const pathname = usePathname();
  const router = useRouter();

  const [search, setSearch] = React.useState('');
  const [bellOpen, setBellOpen] = React.useState(false);
  const [notifications, setNotifications] = React.useState<Notification[]>([]);

  const loadNotifications = React.useCallback(async () => {
    try {
      const page = await api.me.notifications(20, 0);
      setNotifications(page.items);
    } catch {
      // The bell is not important enough to surface an error for.
    }
  }, []);

  React.useEffect(() => {
    if (status !== 'authenticated') return;
    void loadNotifications();
  }, [status, loadNotifications]);

  useSocketEvent(
    'notification:new',
    React.useCallback(({ notification }) => {
      setNotifications((previous) => [notification, ...previous].slice(0, 20));
    }, []),
  );

  // Dismiss the bell popover on an outside click or Escape.
  React.useEffect(() => {
    if (!bellOpen) return;

    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setBellOpen(false);
    };
    const onClick = () => setBellOpen(false);

    document.addEventListener('keydown', onKey);
    // Deferred so the click that opened it does not immediately close it.
    const timer = setTimeout(() => document.addEventListener('click', onClick), 0);

    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('click', onClick);
      clearTimeout(timer);
    };
  }, [bellOpen]);

  if (status === 'loading') {
    return (
      <div style={{ minHeight: '100vh', display: 'grid', placeItems: 'center', color: theme.fg3 }}>
        Loading…
      </div>
    );
  }

  if (status === 'anonymous') return <SignIn />;

  // A guard has no dashboard. Send them to the one screen they can use.
  if (role === 'guard') {
    if (pathname !== '/gate') {
      return <GuardRedirect />;
    }
    return <>{children}</>;
  }

  const unread = notifications.filter((n) => n.readAt == null).length;

  const submitSearch = (event: React.FormEvent) => {
    event.preventDefault();
    const q = search.trim();
    // Search is a request lookup — that is what a dispatcher is asking for when
    // they type a code, a name or a stop.
    router.push(q === '' ? '/requests' : `/requests?q=${encodeURIComponent(q)}`);
  };

  return (
    <div
      style={{
        minHeight: '100vh',
        display: 'grid',
        gridTemplateColumns: '232px minmax(0, 1fr)',
        gridTemplateRows: '56px minmax(0, 1fr)',
        background: theme.page,
      }}
    >
      {/* ── Top bar ────────────────────────────────────────────────────── */}
      <div
        style={{
          gridColumn: '1 / 3',
          display: 'flex',
          alignItems: 'center',
          gap: 16,
          padding: '0 20px',
          background: theme.surface,
          borderBottom: `1px solid ${theme.border}`,
        }}
      >
        <Link
          href="/"
          style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 190, textDecoration: 'none' }}
        >
          <Logo height={28} />
          <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <span style={{ fontSize: 17, fontWeight: weight.bold, color: brand.blueText }}>Shuttle</span>
            <span
              style={{
                fontSize: 10,
                fontWeight: weight.semibold,
                color: theme.fg3,
                border: `1px solid ${theme.borderStrong}`,
                padding: '1px 6px',
                borderRadius: 3,
                letterSpacing: '.06em',
              }}
            >
              ADMIN
            </span>
          </span>
        </Link>

        <form onSubmit={submitSearch} style={{ flex: 1, maxWidth: 480 }}>
          <div
            style={{
              height: 36,
              border: `1px solid ${theme.borderStrong}`,
              borderRadius: radius.md,
              background: theme.sunken,
              display: 'flex',
              alignItems: 'center',
              padding: '0 12px',
              gap: 8,
            }}
          >
            <span
              aria-hidden="true"
              style={{
                width: 14,
                height: 14,
                borderRadius: '50%',
                border: `2px solid ${theme.fg4}`,
                flex: 'none',
              }}
            />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search requests, shuttles, employees…"
              aria-label="Search"
              style={{
                flex: 1,
                minWidth: 0,
                border: 0,
                background: 'transparent',
                outline: 'none',
                font: `400 ${fontSize.base}px 'IBM Plex Sans', sans-serif`,
                color: theme.fg,
              }}
            />
            {search !== '' && (
              <button
                type="button"
                onClick={() => setSearch('')}
                style={{
                  border: 0,
                  background: 'transparent',
                  color: theme.fg3,
                  fontSize: fontSize.sm,
                  cursor: 'pointer',
                }}
              >
                Clear
              </button>
            )}
          </div>
        </form>

        <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 14 }}>
          <ThemeToggle compact />
          {connected ? (
            <LiveDot label="Live" />
          ) : (
            <span style={{ fontSize: fontSize.xs, color: brand.amberText }}>Reconnecting…</span>
          )}

          <div style={{ position: 'relative' }}>
            <button
              type="button"
              aria-label={`Alerts${unread > 0 ? ` (${unread} unread)` : ''}`}
              aria-expanded={bellOpen}
              onClick={(e) => {
                e.stopPropagation();
                setBellOpen((open) => !open);
              }}
              style={{
                position: 'relative',
                width: 36,
                height: 36,
                display: 'grid',
                placeItems: 'center',
                borderRadius: radius.md,
                border: 0,
                background: bellOpen ? brand.bluePale : 'transparent',
                cursor: 'pointer',
              }}
            >
              <span
                aria-hidden="true"
                style={{ width: 18, height: 18, borderRadius: 4, border: `2px solid ${theme.fg2}` }}
              />
              {unread > 0 && (
                <span
                  style={{
                    position: 'absolute',
                    top: 4,
                    right: 4,
                    background: brand.red,
                    color: '#fff',
                    fontSize: 9.5,
                    fontWeight: weight.semibold,
                    padding: '1px 4px',
                    borderRadius: 8,
                    fontFamily: "'IBM Plex Mono', monospace",
                  }}
                >
                  {unread}
                </span>
              )}
            </button>

            {bellOpen && (
              <div
                onClick={(e) => e.stopPropagation()}
                style={{
                  position: 'absolute',
                  top: 42,
                  right: 0,
                  width: 340,
                  background: theme.surface,
                  border: `1px solid ${theme.borderStrong}`,
                  borderRadius: radius.lg,
                  boxShadow: shadow.overlay,
                  overflow: 'hidden',
                  zIndex: 30,
                }}
              >
                <div
                  style={{
                    padding: '12px 16px',
                    borderBottom: `1px solid ${theme.border}`,
                    display: 'flex',
                    alignItems: 'center',
                  }}
                >
                  <span style={{ fontSize: fontSize.base, fontWeight: weight.semibold }}>Alerts</span>
                  {unread > 0 && (
                    <Button
                      variant="ghost"
                      height={24}
                      style={{ marginLeft: 'auto', padding: 0 }}
                      onClick={() => {
                        void api.me.markAllRead().then(loadNotifications);
                      }}
                    >
                      Mark all read
                    </Button>
                  )}
                </div>

                <div style={{ maxHeight: 360, overflowY: 'auto' }} className="sh-scroll">
                  {notifications.length === 0 ? (
                    <div style={{ padding: 20, textAlign: 'center', fontSize: 12.5, color: theme.fg3 }}>
                      All clear.
                    </div>
                  ) : (
                    notifications.map((note) => (
                      <div
                        key={note.id}
                        style={{
                          padding: '12px 16px',
                          borderBottom: `1px solid ${theme.sunken}`,
                          background: note.readAt == null ? theme.selected : theme.surface,
                          display: 'flex',
                          gap: 10,
                        }}
                      >
                        <span
                          style={{
                            width: 8,
                            height: 8,
                            borderRadius: '50%',
                            marginTop: 5,
                            flex: 'none',
                            background: note.readAt == null ? brand.amber : theme.borderStrong,
                          }}
                        />
                        <div style={{ minWidth: 0 }}>
                          <div style={{ fontSize: fontSize.base, fontWeight: weight.medium }}>
                            {note.title}
                          </div>
                          {note.body != null && (
                            <div style={{ fontSize: fontSize.sm, color: theme.fg3, marginTop: 2 }}>
                              {note.body}
                            </div>
                          )}
                          <Mono size={10.5} color={theme.fg4} style={{ display: 'block', marginTop: 4 }}>
                            {formatRelativeDay(note.createdAt)}
                          </Mono>
                        </div>
                      </div>
                    ))
                  )}
                </div>
              </div>
            )}
          </div>

          <button
            type="button"
            onClick={() => void signOut()}
            title="Sign out"
            style={{ border: 0, background: 'transparent', cursor: 'pointer', padding: 0, display: 'flex' }}
          >
            <Avatar name={session?.user.displayName ?? ''} size={30} />
          </button>
        </div>
      </div>

      {/* ── Sidebar ────────────────────────────────────────────────────── */}
      <nav
        style={{
          background: theme.surface,
          borderRight: `1px solid ${theme.border}`,
          padding: '14px 10px',
          display: 'flex',
          flexDirection: 'column',
          gap: 2,
          fontSize: 13.5,
        }}
      >
        {NAV.map((group) => (
          <React.Fragment key={group.group}>
            <div
              style={{
                fontSize: 10.5,
                fontWeight: weight.bold,
                color: theme.fg3,
                letterSpacing: '.1em',
                textTransform: 'uppercase',
                padding: '12px 10px 6px',
              }}
            >
              {group.group}
            </div>
            {group.items.map((item) => {
              const active = pathname === item.href;
              const badge = badges?.[item.href];

              return (
                <Link
                  key={item.href}
                  href={item.href}
                  aria-current={active ? 'page' : undefined}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 10,
                    padding: '8px 10px',
                    borderRadius: radius.md,
                    background: active ? brand.bluePale : 'transparent',
                    color: active ? brand.avatarFg : theme.fg2,
                    fontWeight: active ? weight.semibold : weight.regular,
                    textDecoration: 'none',
                  }}
                >
                  {item.label}
                  {badge != null && badge > 0 && (
                    <Mono
                      size={fontSize.xs}
                      color={theme.fg3}
                      style={{
                        marginLeft: 'auto',
                        background: theme.sunken,
                        padding: '1px 6px',
                        borderRadius: radius.pill,
                      }}
                    >
                      {badge}
                    </Mono>
                  )}
                </Link>
              );
            })}
          </React.Fragment>
        ))}

        <div
          style={{
            marginTop: 'auto',
            padding: '12px 10px',
            fontSize: fontSize.xs,
            color: theme.fg3,
            fontFamily: "'IBM Plex Mono', monospace",
            borderTop: `1px solid ${theme.border}`,
          }}
        >
          <Link href="/gate" style={{ color: brand.blue, textDecoration: 'none' }}>
            Gate tablet →
          </Link>
          <br />
          Env <span style={{ color: theme.fg2 }}>{process.env.NODE_ENV}</span>
        </div>
      </nav>

      {/* ── Content ────────────────────────────────────────────────────── */}
      <div
        style={{
          padding: '20px 28px',
          display: 'flex',
          flexDirection: 'column',
          gap: 16,
          minWidth: 0,
          minHeight: 0,
          overflow: 'hidden',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'flex-end', gap: 16 }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <Mono size={fontSize.sm} color={theme.fg3} style={{ display: 'block', marginBottom: 4 }}>
              {section}
            </Mono>
            <h1 style={{ margin: 0, fontSize: fontSize.h1, fontWeight: weight.semibold, letterSpacing: '-.015em' }}>
              {title}
            </h1>
          </div>
          {actions != null && <div style={{ display: 'flex', gap: 8 }}>{actions}</div>}
        </div>

        {children}
      </div>
    </div>
  );
}

/** Client-side redirect for a guard who landed on a dashboard route. */
function GuardRedirect() {
  const router = useRouter();

  React.useEffect(() => {
    router.replace('/gate');
  }, [router]);

  return (
    <div style={{ minHeight: '100vh', display: 'grid', placeItems: 'center', color: '#677482' }}>
      Opening the gate tablet…
    </div>
  );
}
