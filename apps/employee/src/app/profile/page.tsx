'use client';

import React from 'react';
import { api, useAuth } from '@shuttle/client';
import type { Notification } from '@shuttle/shared-types';
import { formatRelativeDay } from '@shuttle/shared-utils';
import { Avatar, Button, Card, EmptyState, Mono, brand, fontSize, useTheme, weight } from '@shuttle/ui';
import { AppShell } from '@/components/AppShell';

/** Profile and notifications (spec §1 — "Notifications", "Profile"). */
export default function ProfilePage() {
  return (
    <AppShell>
      <ProfileScreen />
    </AppShell>
  );
}

function ProfileScreen() {
  const { theme } = useTheme();
  const { session, signOut } = useAuth();
  const [notifications, setNotifications] = React.useState<Notification[] | null>(null);
  const [busy, setBusy] = React.useState(false);

  const load = React.useCallback(async () => {
    try {
      const page = await api.me.notifications(30, 0);
      setNotifications(page.items);
    } catch {
      setNotifications([]);
    }
  }, []);

  React.useEffect(() => {
    void load();
  }, [load]);

  const markAllRead = async () => {
    setBusy(true);
    try {
      await api.me.markAllRead();
      await load();
    } finally {
      setBusy(false);
    }
  };

  const employee = session?.employee;
  const user = session?.user;
  const unread = notifications?.filter((n) => n.readAt == null).length ?? 0;

  return (
    <div
      className="sh-scroll"
      style={{ flex: 1, overflowY: 'auto', padding: '16px 16px 24px', display: 'flex', flexDirection: 'column', gap: 16 }}
    >
      <h1 style={{ margin: 0, fontSize: fontSize.xl, fontWeight: weight.semibold }}>Profile</h1>

      <Card padding={20}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
          <Avatar name={employee?.displayName ?? user?.displayName ?? ''} size={48} />
          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: fontSize.xl, fontWeight: weight.semibold }}>
              {employee?.displayName ?? user?.displayName}
            </div>
            <div style={{ fontSize: fontSize.base, color: theme.fg3 }}>{user?.email}</div>
          </div>
        </div>

        <div
          style={{
            marginTop: 16,
            paddingTop: 14,
            borderTop: `1px solid ${theme.border}`,
            display: 'grid',
            gridTemplateColumns: '1fr 1fr',
            gap: 12,
          }}
        >
          <Field label="Badge" value={employee?.badgeNo ?? '—'} mono />
          <Field label="Department" value={employee?.department ?? '—'} />
        </div>
      </Card>

      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between' }}>
        <h2 style={{ margin: 0, fontSize: fontSize.lg, fontWeight: weight.semibold }}>
          Notifications
          {unread > 0 && (
            <span style={{ color: brand.blue, fontSize: fontSize.sm, marginLeft: 8 }}>{unread} unread</span>
          )}
        </h2>
        {unread > 0 && (
          <Button variant="ghost" height={32} onClick={() => void markAllRead()} disabled={busy}>
            Mark all read
          </Button>
        )}
      </div>

      <Card padding={0}>
        {notifications == null && (
          <p style={{ padding: 16, margin: 0, color: theme.fg3, fontSize: fontSize.base }}>Loading…</p>
        )}
        {notifications != null && notifications.length === 0 && (
          <EmptyState message="Nothing yet. Updates about your pickups appear here." />
        )}
        {notifications?.map((note, index) => (
          <div
            key={note.id}
            style={{
              padding: '12px 16px',
              borderBottom:
                index === notifications.length - 1 ? 'none' : `1px solid ${theme.sunken}`,
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
                background: note.readAt == null ? brand.blue : theme.borderStrong,
              }}
            />
            <div style={{ minWidth: 0 }}>
              <div style={{ fontSize: fontSize.base, fontWeight: weight.medium }}>{note.title}</div>
              {note.body != null && (
                <div style={{ fontSize: fontSize.sm, color: theme.fg3, marginTop: 2 }}>{note.body}</div>
              )}
              <Mono size={10.5} color={theme.fg4} style={{ display: 'block', marginTop: 4 }}>
                {formatRelativeDay(note.createdAt)}
              </Mono>
            </div>
          </div>
        ))}
      </Card>

      <Button variant="secondary" full height={48} onClick={() => void signOut()}>
        Sign out
      </Button>
    </div>
  );
}

function Field({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  const { theme } = useTheme();
  return (
    <div>
      <div style={{ fontSize: fontSize.xs, color: theme.fg3 }}>{label}</div>
      {mono === true ? (
        <Mono size={fontSize.md} bold>
          {value}
        </Mono>
      ) : (
        <div style={{ fontSize: fontSize.md, fontWeight: weight.medium }}>{value}</div>
      )}
    </div>
  );
}
