'use client';

import React from 'react';
import { api } from '@shuttle/client';
import type { GateLogView, ReportsSummary } from '@shuttle/shared-types';
import {
  appDateKey,
  shiftDateKey,
  formatDistance,
  formatDuration,
  formatTimeWithSeconds,
} from '@shuttle/shared-utils';
import { Button, Card, Mono, StatTile, TextInput, brand, fontSize, useTheme, weight } from '@shuttle/ui';
import { AdminShell } from '@/components/AdminShell';
import { DataTable, cell, type Column } from '@/components/DataTable';

const GATE_COLUMNS: Column[] = [
  { header: 'Log ID', width: '100px' },
  { header: 'In', width: '110px' },
  { header: 'Out', width: '110px' },
  { header: 'Dwell', width: '90px' },
  { header: 'Bus · plate', width: '1fr' },
  { header: 'Driver', width: '1.2fr' },
  { header: 'Pax', width: '70px' },
  { header: 'Remark', width: '2fr' },
  { header: 'Guard', width: '110px' },
];

function today(): string {
  return appDateKey();
}

function daysAgo(days: number): string {
  return shiftDateKey(today(), -days);
}

export default function ReportsPage() {
  const { theme } = useTheme();

  const [from, setFrom] = React.useState(daysAgo(6));
  const [to, setTo] = React.useState(today());
  const [summary, setSummary] = React.useState<ReportsSummary | null>(null);
  const [gateLogs, setGateLogs] = React.useState<GateLogView[]>([]);
  const [loading, setLoading] = React.useState(true);

  React.useEffect(() => {
    void (async () => {
      setLoading(true);
      try {
        const [reportData, gatePage] = await Promise.all([
          api.admin.reports({ from, to }),
          api.gate.logs({ from, to, limit: 200 }),
        ]);
        setSummary(reportData);
        setGateLogs(gatePage.items);
      } finally {
        setLoading(false);
      }
    })();
  }, [from, to]);

  const gatePassengers = gateLogs.reduce((sum, entry) => sum + entry.passengerCount, 0);
  const atGateNow = gateLogs.filter((entry) => entry.checkedOutAt == null).length;
  const edited = gateLogs.filter((entry) => entry.wasEdited).length;
  const closed = gateLogs.filter((entry) => entry.dwellSec != null);
  const avgDwellSec =
    closed.length === 0 ? null : closed.reduce((sum, e) => sum + (e.dwellSec ?? 0), 0) / closed.length;

  // The busiest hour in the window, which is the number the peak-hour question
  // actually asks for.
  const peak = summary?.waitTimes.reduce<{ bucket: string; requests: number } | null>(
    (best, row) => (best == null || row.requests > best.requests ? { bucket: row.bucket, requests: row.requests } : best),
    null,
  );

  return (
    <AdminShell
      section="Insights"
      title="Reports"
      actions={
        <>
          <Button variant="secondary" height={34} onClick={() => void api.admin.exportRequests({ from, to })}>
            Requests CSV
          </Button>
          <Button variant="secondary" height={34} onClick={() => void api.admin.exportTrips({ from, to })}>
            Trips CSV
          </Button>
          <Button height={34} onClick={() => void api.gate.exportCsv({ from, to })}>
            Gate log CSV
          </Button>
        </>
      }
    >
      <div style={{ display: 'flex', alignItems: 'flex-end', gap: 12 }}>
        <div style={{ width: 160 }}>
          <div style={{ fontSize: fontSize.xs, color: theme.fg3, marginBottom: 4 }}>From</div>
          <input
            type="date"
            value={from}
            max={to}
            onChange={(e) => setFrom(e.target.value)}
            className="sh-input"
            style={dateInputStyle(theme.borderStrong, theme.surface, theme.fg)}
          />
        </div>
        <div style={{ width: 160 }}>
          <div style={{ fontSize: fontSize.xs, color: theme.fg3, marginBottom: 4 }}>To</div>
          <input
            type="date"
            value={to}
            min={from}
            max={today()}
            onChange={(e) => setTo(e.target.value)}
            className="sh-input"
            style={dateInputStyle(theme.borderStrong, theme.surface, theme.fg)}
          />
        </div>
        <span style={{ fontSize: fontSize.sm, color: theme.fg3, paddingBottom: 10 }}>
          {loading ? 'Loading…' : `${summary?.from} → ${summary?.to}`}
        </span>
      </div>

      {/* Service KPIs */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 14 }}>
        <StatTile
          label="Trips completed"
          value={summary?.utilization.reduce((sum, u) => sum + u.trips, 0) ?? '—'}
          sub={`${summary?.utilization.reduce((sum, u) => sum + u.passengers, 0) ?? 0} passengers`}
        />
        <StatTile
          label="Avg wait"
          value={
            summary == null || summary.waitTimes.length === 0
              ? '—'
              : (
                  summary.waitTimes.reduce((sum, w) => sum + (w.avgWaitSec ?? 0), 0) /
                  summary.waitTimes.filter((w) => w.avgWaitSec != null).length /
                  60
                ).toFixed(1)
          }
          unit="min"
          sub="request → shuttle arrived"
        />
        <StatTile
          label="Peak hour"
          value={peak?.bucket ?? '—'}
          sub={peak == null ? 'no data' : `${peak.requests} requests`}
        />
        <StatTile
          label="Seat utilization"
          value={
            summary == null || summary.utilization.length === 0
              ? '—'
              : Math.round(
                  summary.utilization.reduce((sum, u) => sum + (u.seatUtilizationPct ?? 0), 0) /
                    Math.max(1, summary.utilization.filter((u) => u.seatUtilizationPct != null).length),
                )
          }
          unit="%"
          sub="passengers ÷ seats offered"
        />
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 16 }}>
        {/* Wait time by hour */}
        <Card padding={20}>
          <h2 style={{ margin: '0 0 14px', fontSize: fontSize.lg, fontWeight: weight.semibold }}>
            Wait time by hour
          </h2>

          {summary == null || summary.waitTimes.length === 0 ? (
            <p style={{ margin: 0, fontSize: fontSize.base, color: theme.fg3 }}>
              No completed pickups in this window.
            </p>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {summary.waitTimes.map((row) => {
                const maxWait = Math.max(...summary.waitTimes.map((w) => w.avgWaitSec ?? 0), 1);
                return (
                  <div key={row.bucket} style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                    <Mono size={fontSize.sm} color={theme.fg3} style={{ width: 46, flex: 'none' }}>
                      {row.bucket}
                    </Mono>
                    <div style={{ flex: 1, height: 18, background: theme.sunken, borderRadius: 2, overflow: 'hidden' }}>
                      <div
                        style={{
                          width: `${((row.avgWaitSec ?? 0) / maxWait) * 100}%`,
                          height: '100%',
                          background: brand.blue,
                        }}
                      />
                    </div>
                    <Mono size={fontSize.sm} color={theme.fg2} style={{ width: 96, flex: 'none', textAlign: 'right' }}>
                      {formatDuration(row.avgWaitSec)} · {row.requests}
                    </Mono>
                  </div>
                );
              })}
              <p style={{ margin: '6px 0 0', fontSize: fontSize.sm, color: theme.fg3 }}>
                Bar is the mean wait; the second figure is the request count in that hour.
              </p>
            </div>
          )}
        </Card>

        {/* Utilization + popular stops */}
        <Card padding={20}>
          <h2 style={{ margin: '0 0 14px', fontSize: fontSize.lg, fontWeight: weight.semibold }}>
            Shuttle utilization
          </h2>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {(summary?.utilization ?? []).map((row) => (
              <div key={row.shuttleId} style={{ display: 'flex', justifyContent: 'space-between', fontSize: fontSize.base }}>
                <span style={{ fontWeight: weight.medium }}>{row.shuttleName}</span>
                <Mono size={fontSize.sm} color={theme.fg2}>
                  {row.trips} trips · {row.passengers} pax ·{' '}
                  {row.seatUtilizationPct == null ? '—' : `${row.seatUtilizationPct}%`} ·{' '}
                  {formatDuration(row.activeMinutes * 60)}
                </Mono>
              </div>
            ))}
            {(summary?.utilization.length ?? 0) === 0 && (
              <p style={{ margin: 0, fontSize: fontSize.base, color: theme.fg3 }}>No trips in this window.</p>
            )}
          </div>

          <h2 style={{ margin: '20px 0 14px', fontSize: fontSize.lg, fontWeight: weight.semibold }}>
            Popular stops
          </h2>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {(summary?.popularStops ?? [])
              .filter((row) => row.pickups + row.dropoffs > 0)
              .slice(0, 8)
              .map((row) => (
                <div key={row.stopId} style={{ display: 'flex', justifyContent: 'space-between', fontSize: fontSize.base }}>
                  <span>{row.stopName}</span>
                  <Mono size={fontSize.sm} color={theme.fg2}>
                    {row.pickups} pickups · {row.dropoffs} drop-offs
                  </Mono>
                </div>
              ))}
            {(summary?.popularStops.filter((r) => r.pickups + r.dropoffs > 0).length ?? 0) === 0 && (
              <p style={{ margin: 0, fontSize: fontSize.base, color: theme.fg3 }}>
                No completed pickups in this window.
              </p>
            )}
          </div>
        </Card>
      </div>

      {/* Gate log */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 14 }}>
        <StatTile label="Gate check-ins" value={gateLogs.length} unit="in window" sub={`${atGateNow} at gate now`} />
        <StatTile label="Passengers dropped" value={gatePassengers} sub="Main Building" />
        <StatTile
          label="Avg dwell"
          value={avgDwellSec == null ? '—' : (avgDwellSec / 60).toFixed(1)}
          unit="min"
          sub="check-in → check-out"
        />
        <StatTile label="Edited entries" value={edited} sub="corrected by a guard" />
      </div>

      <div style={{ flex: 1, minHeight: 240, display: 'flex', flexDirection: 'column' }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, marginBottom: 10 }}>
          <h2 style={{ margin: 0, fontSize: fontSize.lg, fontWeight: weight.semibold }}>
            Main Building gate log
          </h2>
          <span style={{ fontSize: fontSize.sm, color: theme.fg3 }}>
            Recorded by security on the gate tablet · live
          </span>
        </div>

        <DataTable
          columns={GATE_COLUMNS}
          emptyMessage={loading ? 'Loading…' : 'No gate activity in this window.'}
          footer={`${gateLogs.length} entries · ${gatePassengers} passengers`}
          rows={gateLogs.map((entry) => ({
            id: entry.id,
            cells: [
              cell.text(entry.code, { mono: true, color: brand.blue, bold: true }),
              cell.text(formatTimeWithSeconds(entry.checkedInAt), { mono: true }),
              cell.text(entry.checkedOutAt == null ? 'at gate' : formatTimeWithSeconds(entry.checkedOutAt), {
                mono: true,
                color: entry.checkedOutAt == null ? brand.amberText : theme.fg,
              }),
              cell.text(formatDuration(entry.dwellSec), { mono: true, color: theme.fg2 }),
              cell.text(`${entry.shuttleName} · ${entry.shuttlePlateNo}`),
              cell.text(entry.driverName ?? '—', { color: theme.fg2 }),
              cell.text(entry.passengerCount, { mono: true }),
              cell.text(entry.remark ?? '—', { color: entry.remark == null ? theme.fg4 : theme.fg }),
              cell.text(`${entry.guardName}${entry.wasEdited ? ' · edited' : ''}`, { color: theme.fg2 }),
            ],
          }))}
        />
      </div>
    </AdminShell>
  );
}

function dateInputStyle(border: string, background: string, colour: string): React.CSSProperties {
  return {
    height: 34,
    width: '100%',
    padding: '0 10px',
    border: `1px solid ${border}`,
    borderRadius: 6,
    background,
    color: colour,
    fontFamily: "'IBM Plex Mono', monospace",
    fontSize: 13,
    outline: 'none',
  };
}
