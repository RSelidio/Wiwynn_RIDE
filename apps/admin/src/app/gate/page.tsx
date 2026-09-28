'use client';

import React from 'react';
import { api, ApiRequestError, useAuth, useSocketEvent } from '@shuttle/client';
import type { Gate, GateLogView, Shuttle } from '@shuttle/shared-types';
import {
  appDateTimeInput,
  appDateTimeInputToIso,
  formatTimeWithSeconds,
} from '@shuttle/shared-utils';
import {
  Button,
  FilterChips,
  Label,
  LiveDot,
  Logo,
  Mono,
  SegmentedControl,
  StatusPill,
  Stepper,
  useTheme,
  TextInput,
  Toast,
  brand,
  fontSize,
  radius,
  weight,
  type Theme,
} from '@shuttle/ui';

/**
 * Security guard gate tablet (design doc §4a).
 *
 * The guard only checks shuttles in and out. Bus, plate and driver arrive
 * pre-filled from dispatch; Check in stamps the arrival, Check out stamps the
 * departure. Passenger count and a remark are optional. Mistakes are fixed in
 * the log on the right — tap a row to edit times, count or remark, or remove it.
 * Reports live in the admin dashboard, not here.
 *
 * This screen renders its own chrome rather than the AdminShell: it runs
 * full-screen on a wall-mounted tablet, and it is the only surface with a
 * dark mode (a gatehouse at night).
 */

type Filter = 'all' | 'open' | 'closed';

const FILTERS = [
  { value: 'all' as const, label: 'All' },
  { value: 'open' as const, label: 'At gate' },
  { value: 'closed' as const, label: 'Departed' },
];

interface EditDraft {
  checkedInAt: string;
  checkedOutAt: string;
  passengerCount: number;
  remark: string;
}

export default function GatePage() {
  const { session } = useAuth();
  const { theme, name: themeName, setName: setThemeName } = useTheme();

  const [gates, setGates] = React.useState<Gate[]>([]);
  const [gateId, setGateId] = React.useState<string | null>(null);
  const [shuttles, setShuttles] = React.useState<Shuttle[]>([]);
  const [logs, setLogs] = React.useState<GateLogView[]>([]);
  const [filter, setFilter] = React.useState<Filter>('all');
  const [selectedShuttleId, setSelectedShuttleId] = React.useState<string | null>(null);
  const [editingId, setEditingId] = React.useState<string | null>(null);
  const [draft, setDraft] = React.useState<EditDraft | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [toast, setToast] = React.useState<string | null>(null);
  // Start with a stable server/client value. Reading the wall clock during
  // render differs between SSR and hydration and triggers a text mismatch.
  const [clock, setClock] = React.useState<Date | null>(null);

  const flash = React.useCallback((message: string) => {
    setToast(message);
    setTimeout(() => setToast(null), 2_600);
  }, []);

  // A gatehouse clock, because the guard reads the stamp against it.
  React.useEffect(() => {
    setClock(new Date());
    const timer = setInterval(() => setClock(new Date()), 1_000);
    return () => clearInterval(timer);
  }, []);

  React.useEffect(() => {
    void (async () => {
      try {
        const [gateList, shuttleList] = await Promise.all([api.gate.gates(), api.fleet.shuttles()]);
        setGates(gateList);
        setShuttles(shuttleList);
        const first = gateList[0]?.id ?? null;
        setGateId(first);
        setSelectedShuttleId(shuttleList[0]?.id ?? null);
        if (first != null) await api.gate.watch(first);
      } catch (err) {
        flash(err instanceof ApiRequestError ? err.message : 'Could not load the gate.');
      }
    })();
  }, [flash]);

  const loadLogs = React.useCallback(async () => {
    if (gateId == null) return;
    try {
      const page = await api.gate.logs({ gateId, limit: 100 });
      setLogs(page.items);
    } catch {
      // A failed refresh leaves the previous list on screen, which is better
      // than blanking a log the guard is reading.
    }
  }, [gateId]);

  React.useEffect(() => {
    void loadLogs();
  }, [loadLogs]);

  // Another tablet at the same gate stamping an entry shows up here at once.
  useSocketEvent(
    'gate:changed',
    React.useCallback(() => {
      void loadLogs();
    }, [loadLogs]),
  );

  const openEntries = logs.filter((entry) => entry.checkedOutAt == null);
  const visible = logs.filter((entry) =>
    filter === 'all' ? true : filter === 'open' ? entry.checkedOutAt == null : entry.checkedOutAt != null,
  );

  const selectedShuttle = shuttles.find((s) => s.id === selectedShuttleId) ?? null;
  const openForSelected = openEntries.find((entry) => entry.shuttleId === selectedShuttleId) ?? null;
  const lastForSelected =
    logs.find((entry) => entry.shuttleId === selectedShuttleId && entry.checkedOutAt != null) ?? null;

  const phase: 'approaching' | 'at_gate' | 'departed' =
    openForSelected != null ? 'at_gate' : lastForSelected != null ? 'departed' : 'approaching';

  // ── Actions ──────────────────────────────────────────────────────────────

  const checkIn = async () => {
    if (gateId == null || selectedShuttleId == null || busy) return;
    setBusy(true);
    try {
      const entry = await api.gate.checkIn(gateId, selectedShuttleId);
      flash(`${entry.shuttleName} checked in · ${formatTimeWithSeconds(entry.checkedInAt).slice(0, 5)}`);
      await loadLogs();
    } catch (err) {
      flash(err instanceof ApiRequestError ? err.message : 'Check-in failed.');
    } finally {
      setBusy(false);
    }
  };

  const checkOut = async () => {
    if (openForSelected == null || busy) return;
    setBusy(true);
    try {
      const entry = await api.gate.checkOut(openForSelected.id);
      flash(
        `${entry.shuttleName} checked out · ${formatTimeWithSeconds(entry.checkedOutAt ?? '').slice(0, 5)}`,
      );
      await loadLogs();
    } catch (err) {
      flash(err instanceof ApiRequestError ? err.message : 'Check-out failed.');
    } finally {
      setBusy(false);
    }
  };

  const setPassengers = async (count: number) => {
    if (openForSelected == null) return;
    // Optimistic: the stepper must not lag behind the guard's finger.
    setLogs((previous) =>
      previous.map((entry) =>
        entry.id === openForSelected.id ? { ...entry, passengerCount: count } : entry,
      ),
    );
    try {
      await api.gate.setPassengers(openForSelected.id, count);
    } catch {
      await loadLogs();
      flash('Could not save the passenger count.');
    }
  };

  const saveRemark = async (remark: string) => {
    if (openForSelected == null) return;
    try {
      await api.gate.update(openForSelected.id, { remark: remark === '' ? null : remark });
      await loadLogs();
    } catch {
      flash('Could not save the remark.');
    }
  };

  const beginEdit = (entry: GateLogView) => {
    setEditingId(entry.id);
    setDraft({
      checkedInAt: appDateTimeInput(entry.checkedInAt),
      checkedOutAt: appDateTimeInput(entry.checkedOutAt),
      passengerCount: entry.passengerCount,
      remark: entry.remark ?? '',
    });
  };

  const saveEdit = async () => {
    if (editingId == null || draft == null || busy) return;

    const checkedInAt = appDateTimeInputToIso(draft.checkedInAt);
    if (checkedInAt == null) {
      flash('Check-in time is required.');
      return;
    }

    setBusy(true);
    try {
      await api.gate.update(editingId, {
        checkedInAt,
        // Clearing the field re-opens the entry, which is how a mistaken
        // check-out is undone.
        checkedOutAt: appDateTimeInputToIso(draft.checkedOutAt),
        passengerCount: draft.passengerCount,
        remark: draft.remark === '' ? null : draft.remark,
      });
      flash('Entry updated');
      setEditingId(null);
      setDraft(null);
      await loadLogs();
    } catch (err) {
      flash(err instanceof ApiRequestError ? err.message : 'Could not save the entry.');
    } finally {
      setBusy(false);
    }
  };

  const removeEntry = async () => {
    if (editingId == null || busy) return;
    setBusy(true);
    try {
      await api.gate.remove(editingId);
      flash('Entry removed');
      setEditingId(null);
      setDraft(null);
      await loadLogs();
    } catch (err) {
      flash(err instanceof ApiRequestError ? err.message : 'Could not remove the entry.');
    } finally {
      setBusy(false);
    }
  };

  const gate = gates.find((g) => g.id === gateId);
  const totalPassengers = logs.reduce((sum, entry) => sum + entry.passengerCount, 0);

  // ── Render ───────────────────────────────────────────────────────────────

  return (
    <div
      data-theme={themeName}
      style={{
        minHeight: '100vh',
        background: theme.page,
        color: theme.fg,
        display: 'grid',
        gridTemplateColumns: '272px minmax(0, 1fr) 380px',
        gridTemplateRows: '56px minmax(0, 1fr)',
        fontFamily: "'IBM Plex Sans', sans-serif",
        position: 'relative',
      }}
    >
      {/* ── Top bar ─────────────────────────────────────────────────────── */}
      <div
        style={{
          gridColumn: '1 / -1',
          display: 'flex',
          alignItems: 'center',
          gap: 14,
          padding: '0 20px',
          background: theme.surface,
          borderBottom: `1px solid ${theme.border}`,
        }}
      >
        <Logo height={22} />
        <div style={{ width: 1, height: 22, background: theme.border }} />
        <div style={{ display: 'flex', flexDirection: 'column', lineHeight: 1.2 }}>
          <span style={{ fontSize: fontSize.md, fontWeight: weight.semibold, color: theme.accent }}>
            Gate Log
          </span>
          <span style={{ fontSize: fontSize.xs, color: theme.fg3 }}>{gate?.name ?? 'Loading…'}</span>
        </div>

        <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 14 }}>
          <LiveDot />
          <Mono
            size={fontSize.lg}
            bold
            style={{
              padding: '5px 10px',
              border: `1px solid ${theme.border}`,
              borderRadius: radius.md,
              background: theme.page,
            }}
          >
            {clock == null ? '--:--:--' : formatTimeWithSeconds(clock)}
          </Mono>

          <SegmentedControl
            options={[
              { value: 'light' as const, label: 'Light' },
              { value: 'dark' as const, label: 'Dark' },
            ]}
            value={themeName}
            onChange={setThemeName}
          />

          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span
              style={{
                width: 32,
                height: 32,
                borderRadius: '50%',
                background: brand.avatarBg,
                color: brand.avatarFg,
                fontSize: fontSize.xs,
                fontWeight: weight.semibold,
                display: 'grid',
                placeItems: 'center',
              }}
            >
              {(session?.user.displayName ?? '?')
                .split(/\s+/)
                .slice(0, 2)
                .map((p) => p[0])
                .join('')
                .toUpperCase()}
            </span>
            <div style={{ display: 'flex', flexDirection: 'column', lineHeight: 1.2 }}>
              <span style={{ fontSize: 12.5, fontWeight: weight.semibold }}>
                {session?.user.displayName}
              </span>
              <span style={{ fontSize: fontSize.xs, color: theme.fg3 }}>Security</span>
            </div>
          </div>
        </div>
      </div>

      {/* ── Shuttle queue ───────────────────────────────────────────────── */}
      <div
        style={{
          borderRight: `1px solid ${theme.border}`,
          background: theme.surface,
          padding: '16px 14px',
          display: 'flex',
          flexDirection: 'column',
          gap: 10,
          minHeight: 0,
          overflowY: 'auto',
        }}
        className="sh-scroll"
      >
        <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', padding: '0 4px' }}>
          <span style={{ fontSize: fontSize.base, fontWeight: weight.semibold }}>Shuttles</span>
          <Mono size={fontSize.xs} color={theme.fg3}>
            {openEntries.length} at gate
          </Mono>
        </div>

        {shuttles.map((shuttle) => {
          const open = openEntries.find((entry) => entry.shuttleId === shuttle.id);
          const last = logs.find((entry) => entry.shuttleId === shuttle.id && entry.checkedOutAt != null);
          const selected = shuttle.id === selectedShuttleId;

          const status = open != null ? 'At gate' : last != null ? 'Departed' : 'Approaching';
          const tone = open != null ? 'info' : last != null ? 'ok' : 'warn';

          return (
            <button
              key={shuttle.id}
              type="button"
              onClick={() => setSelectedShuttleId(shuttle.id)}
              style={{
                cursor: 'pointer',
                textAlign: 'left',
                border: `1px solid ${selected ? theme.accentBtn : theme.border}`,
                boxShadow: selected ? '0 0 0 2px rgba(0,96,144,.22)' : 'none',
                borderRadius: radius.lg,
                padding: 12,
                display: 'flex',
                flexDirection: 'column',
                gap: 8,
                background: selected ? theme.selected : theme.surface,
                color: theme.fg,
                font: 'inherit',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span
                  style={{
                    width: 24,
                    height: 24,
                    borderRadius: '50%',
                    background: brand.blue,
                    color: '#fff',
                    fontFamily: "'IBM Plex Mono', monospace",
                    fontSize: fontSize.xs,
                    fontWeight: weight.semibold,
                    display: 'grid',
                    placeItems: 'center',
                    flex: 'none',
                  }}
                >
                  {shuttle.code.replace(/\D/g, '') || '•'}
                </span>
                <span style={{ fontSize: 13.5, fontWeight: weight.semibold }}>{shuttle.name}</span>
                <span style={{ marginLeft: 'auto' }}>
                  <StatusPill label={status} tone={tone} />
                </span>
              </div>

              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  fontSize: 11.5,
                  color: theme.fg2,
                }}
              >
                <Mono size={fontSize.sm} bold color={theme.fg}>
                  {shuttle.plateNo}
                </Mono>
                <span>{open?.driverName ?? last?.driverName ?? '—'}</span>
              </div>

              <Mono size={fontSize.xs} color={theme.fg3}>
                {open != null
                  ? `In ${formatTimeWithSeconds(open.checkedInAt)}`
                  : last != null
                    ? `Out ${formatTimeWithSeconds(last.checkedOutAt)}`
                    : 'Not at the gate yet'}
              </Mono>
            </button>
          );
        })}

        <p style={{ marginTop: 'auto', fontSize: fontSize.xs, lineHeight: 1.45, color: theme.fg3, padding: '0 4px' }}>
          Bus, plate and driver come from dispatch. You only stamp arrival and departure.
        </p>
      </div>

      {/* ── Check in / out panel ────────────────────────────────────────── */}
      <div style={{ padding: '22px 26px', display: 'flex', flexDirection: 'column', gap: 16, minHeight: 0, overflowY: 'auto' }}>
        {selectedShuttle == null ? (
          <p style={{ color: theme.fg3, fontSize: fontSize.md }}>Select a shuttle on the left.</p>
        ) : (
          <>
            <div style={{ display: 'flex', alignItems: 'flex-end', gap: 16 }}>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                <Label color={theme.fg3}>
                  {phase === 'at_gate' ? 'AT GATE' : phase === 'departed' ? 'DEPARTED' : 'APPROACHING'}
                </Label>
                <span style={{ fontSize: 24, fontWeight: weight.semibold, lineHeight: 1.1 }}>
                  {selectedShuttle.name}
                </span>
              </div>

              <div style={{ marginLeft: 'auto', display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 4 }}>
                <Label color={theme.fg3}>Plate</Label>
                <Mono
                  size={24}
                  bold
                  style={{
                    letterSpacing: '.08em',
                    padding: '4px 14px',
                    border: `2px solid ${theme.fg}`,
                    borderRadius: radius.md,
                    background: theme.surface,
                  }}
                >
                  {selectedShuttle.plateNo}
                </Mono>
              </div>
            </div>

            {/* Check in / out stamps */}
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
              <StampCard
                theme={theme}
                label="CHECK IN"
                time={
                  openForSelected != null
                    ? formatTimeWithSeconds(openForSelected.checkedInAt)
                    : lastForSelected != null
                      ? formatTimeWithSeconds(lastForSelected.checkedInAt)
                      : '—'
                }
                sub={
                  phase === 'approaching'
                    ? 'Not at the gate yet'
                    : `Stamped · ${(openForSelected ?? lastForSelected)?.code ?? ''}`
                }
                muted={phase === 'approaching'}
              />
              <StampCard
                theme={theme}
                label="CHECK OUT"
                time={
                  lastForSelected != null && openForSelected == null
                    ? formatTimeWithSeconds(lastForSelected.checkedOutAt)
                    : '—'
                }
                sub={
                  phase === 'departed'
                    ? 'Stamped by Check out'
                    : phase === 'at_gate'
                      ? 'Waiting for departure'
                      : '—'
                }
                muted={phase !== 'departed'}
              />
            </div>

            {/* Optional details, only while the shuttle is standing there */}
            {openForSelected != null && (
              <div style={{ display: 'grid', gridTemplateColumns: 'auto minmax(0, 1fr)', gap: 24, alignItems: 'start' }}>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  <Label color={theme.fg3}>Passengers</Label>
                  <Stepper
                    value={openForSelected.passengerCount}
                    onChange={(n) => void setPassengers(n)}
                    min={0}
                    max={selectedShuttle.capacity}
                  />
                  <span style={{ fontSize: fontSize.xs, color: theme.fg3 }}>
                    optional · of {selectedShuttle.capacity} seats
                  </span>
                </div>

                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  <Label color={theme.fg3}>Remark</Label>
                  <RemarkField
                    initial={openForSelected.remark ?? ''}
                    onCommit={(value) => void saveRemark(value)}
                  />
                  <span style={{ fontSize: fontSize.xs, color: theme.fg3 }}>
                    optional · saved when you tap away · max 120 characters
                  </span>
                </div>
              </div>
            )}

            {/* Primary action */}
            <div
              style={{
                marginTop: 'auto',
                display: 'flex',
                alignItems: 'center',
                gap: 14,
                paddingTop: 14,
                borderTop: `1px solid ${theme.border}`,
              }}
            >
              <span style={{ fontSize: fontSize.sm, color: theme.fg3 }}>
                {phase === 'approaching'
                  ? 'Tap Check in when the shuttle stops at the gate'
                  : phase === 'at_gate'
                    ? 'Count is optional · tap Check out when it leaves'
                    : 'Fix any mistake from the log on the right'}
              </span>

              {phase === 'departed' && lastForSelected != null && (
                <Button
                  variant="secondary"
                  height={48}
                  style={{ marginLeft: 'auto' }}
                  onClick={() => beginEdit(lastForSelected)}
                >
                  Edit in log
                </Button>
              )}

              <Button
                height={48}
                style={{ marginLeft: phase === 'departed' ? 0 : 'auto', padding: '0 26px' }}
                disabled={busy || gateId == null}
                onClick={() => void (phase === 'at_gate' ? checkOut() : checkIn())}
              >
                {phase === 'at_gate' ? 'Check out' : phase === 'departed' ? 'Check in again' : 'Check in'}
              </Button>
            </div>
          </>
        )}
      </div>

      {/* ── Today's log ─────────────────────────────────────────────────── */}
      <div
        style={{
          borderLeft: `1px solid ${theme.border}`,
          background: theme.surface,
          display: 'flex',
          flexDirection: 'column',
          minHeight: 0,
        }}
      >
        <div style={{ padding: '14px 16px 10px', display: 'flex', flexDirection: 'column', gap: 10, borderBottom: `1px solid ${theme.border}` }}>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
            <span style={{ fontSize: fontSize.base, fontWeight: weight.semibold }}>Today&rsquo;s log</span>
            <span style={{ marginLeft: 'auto', fontSize: fontSize.xs, color: theme.fg3 }}>
              {logs.length} entries · {totalPassengers} passengers
            </span>
          </div>
          <FilterChips options={FILTERS} value={filter} onChange={setFilter} />
        </div>

        <div className="sh-scroll" style={{ flex: 1, overflowY: 'auto' }}>
          {visible.length === 0 && (
            <div style={{ padding: '28px 16px', textAlign: 'center', fontSize: 12.5, color: theme.fg3 }}>
              No entries match this filter.
            </div>
          )}

          {visible.map((entry) => {
            const editing = editingId === entry.id;

            if (editing && draft != null) {
              return (
                <div
                  key={entry.id}
                  style={{
                    borderBottom: `1px solid ${theme.border}`,
                    background: theme.selected,
                    padding: '12px 16px',
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 10,
                    borderLeft: `2px solid ${brand.blue}`,
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
                    <span style={{ fontSize: fontSize.base, fontWeight: weight.semibold }}>
                      Edit · {entry.shuttleName}
                    </span>
                    <Mono size={fontSize.xs} color={theme.fg3} style={{ marginLeft: 'auto' }}>
                      {entry.code}
                    </Mono>
                  </div>

                  <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                    <Label color={theme.fg3}>In</Label>
                    <input
                      type="datetime-local"
                      step={1}
                      value={draft.checkedInAt}
                      onChange={(e) => setDraft({ ...draft, checkedInAt: e.target.value })}
                      className="sh-input"
                      style={editInputStyle(theme)}
                    />
                  </label>

                  <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                    <Label color={theme.fg3}>Out · clear to re-open</Label>
                    <input
                      type="datetime-local"
                      step={1}
                      value={draft.checkedOutAt}
                      onChange={(e) => setDraft({ ...draft, checkedOutAt: e.target.value })}
                      className="sh-input"
                      style={editInputStyle(theme)}
                    />
                  </label>

                  <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                    <Label color={theme.fg3}>Passengers</Label>
                    <input
                      type="number"
                      min={0}
                      max={200}
                      value={draft.passengerCount}
                      onChange={(e) =>
                        setDraft({ ...draft, passengerCount: Math.max(0, Number(e.target.value) || 0) })
                      }
                      className="sh-input"
                      style={editInputStyle(theme)}
                    />
                  </label>

                  <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                    <Label color={theme.fg3}>Remark</Label>
                    <input
                      value={draft.remark}
                      maxLength={120}
                      onChange={(e) => setDraft({ ...draft, remark: e.target.value })}
                      className="sh-input"
                      style={{ ...editInputStyle(theme), fontFamily: "'IBM Plex Sans', sans-serif" }}
                    />
                  </label>

                  <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                    <Button variant="danger" height={36} disabled={busy} onClick={() => void removeEntry()}>
                      Remove
                    </Button>
                    <Button
                      variant="secondary"
                      height={36}
                      style={{ marginLeft: 'auto' }}
                      onClick={() => {
                        setEditingId(null);
                        setDraft(null);
                      }}
                    >
                      Cancel
                    </Button>
                    <Button height={36} disabled={busy} onClick={() => void saveEdit()}>
                      Save
                    </Button>
                  </div>
                </div>
              );
            }

            const open = entry.checkedOutAt == null;

            return (
              <button
                key={entry.id}
                type="button"
                onClick={() => beginEdit(entry)}
                style={{
                  width: '100%',
                  textAlign: 'left',
                  border: 0,
                  borderBottom: `1px solid ${theme.border}`,
                  background: theme.surface,
                  color: theme.fg,
                  font: 'inherit',
                  cursor: 'pointer',
                  padding: '12px 16px',
                  display: 'grid',
                  gridTemplateColumns: 'minmax(0, 1fr) auto',
                  gap: '6px 10px',
                }}
              >
                <span style={{ fontSize: fontSize.base, fontWeight: weight.semibold }}>
                  {entry.shuttleName}{' '}
                  <Mono size={11.5} color={theme.fg2}>
                    · {entry.shuttlePlateNo}
                  </Mono>
                </span>
                <Mono size={12.5} bold style={{ textAlign: 'right' }}>
                  {entry.passengerCount} pax
                </Mono>

                <Mono size={fontSize.sm} color={theme.fg2}>
                  In {formatTimeWithSeconds(entry.checkedInAt)} · Out{' '}
                  {entry.checkedOutAt == null ? '—' : formatTimeWithSeconds(entry.checkedOutAt)}
                </Mono>
                <span style={{ justifySelf: 'end' }}>
                  <StatusPill label={open ? 'At gate' : 'Departed'} tone={open ? 'info' : 'ok'} />
                </span>

                <span
                  style={{
                    gridColumn: '1 / -1',
                    fontSize: 11.5,
                    color: entry.remark == null ? theme.fg3 : theme.fg,
                    whiteSpace: 'nowrap',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                  }}
                >
                  {entry.remark ?? 'No remark'}
                </span>

                <Mono size={10.5} color={theme.fg3} style={{ gridColumn: '1 / -1' }}>
                  {entry.code} · {entry.driverName ?? 'no driver'}
                  {entry.wasEdited ? ' · edited' : ''}
                </Mono>
              </button>
            );
          })}
        </div>
      </div>

      <Toast message={toast ?? ''} visible={toast != null} position="top" />
    </div>
  );
}

function editInputStyle(theme: Theme): React.CSSProperties {
  return {
    height: 38,
    padding: '0 8px',
    border: `1px solid ${theme.borderStrong}`,
    borderRadius: radius.md,
    background: theme.page,
    color: theme.fg,
    fontFamily: "'IBM Plex Mono', monospace",
    fontSize: 12.5,
    outline: 'none',
    width: '100%',
    boxSizing: 'border-box',
    colorScheme: theme.colorScheme,
  };
}

function StampCard({
  theme,
  label,
  time,
  sub,
  muted,
}: {
  theme: Theme;
  label: string;
  time: string;
  sub: string;
  muted: boolean;
}) {
  return (
    <div
      style={{
        background: theme.surface,
        border: `1px solid ${theme.border}`,
        borderRadius: radius.lg,
        padding: '14px 16px',
        display: 'flex',
        flexDirection: 'column',
        gap: 6,
      }}
    >
      <Label color={theme.fg3}>{label}</Label>
      <Mono size={26} bold color={muted ? theme.fg3 : theme.fg} style={{ lineHeight: 1.1 }}>
        {time}
      </Mono>
      <span style={{ fontSize: 11.5, color: theme.fg2 }}>{sub}</span>
    </div>
  );
}

/**
 * Remark field with local state.
 *
 * Committed on blur rather than per keystroke: a PATCH per character would
 * flood the API and fight the guard's typing.
 */
function RemarkField({
  initial,
  onCommit,
}: {
  initial: string;
  onCommit: (value: string) => void;
}) {
  const [value, setValue] = React.useState(initial);

  // Re-sync when a different entry is selected.
  React.useEffect(() => {
    setValue(initial);
  }, [initial]);

  return (
    <TextInput
      value={value}
      onChange={setValue}
      onCommit={onCommit}
      maxLength={120}
      placeholder="e.g. visitor on board, late by 5 min"
      style={{ width: '100%' }}
    />
  );
}
