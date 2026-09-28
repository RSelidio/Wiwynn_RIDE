'use client';

import React from 'react';
import { useSearchParams } from 'next/navigation';
import { api, useSocketEvent } from '@shuttle/client';
import { REQUEST_STATUSES, type PickupRequestView, type RequestStatus, type ShuttleStatusView } from '@shuttle/shared-types';
import { formatTime, humanizeEtaSec, requestStatusLabel } from '@shuttle/shared-utils';
import { Button, FilterChips, brand, fontSize, requestTone, useTheme } from '@shuttle/ui';
import { AdminShell } from '@/components/AdminShell';
import { DataTable, cell, type Column } from '@/components/DataTable';
import { RequestDrawer } from '@/components/RequestDrawer';

const COLUMNS: Column[] = [
  { header: 'ID', width: '100px' },
  { header: 'Employee', width: '1.2fr' },
  { header: 'Dept', width: '1fr' },
  { header: 'Pickup', width: '1fr' },
  { header: 'Destination', width: '1fr' },
  { header: 'Pax', width: '60px' },
  { header: 'Shuttle', width: '110px' },
  { header: 'ETA', width: '80px' },
  { header: 'Requested', width: '90px' },
  { header: 'Status', width: '130px' },
];

const FILTERS = [
  { value: 'All' as const, label: 'All' },
  ...REQUEST_STATUSES.map((status) => ({ value: status, label: requestStatusLabel(status) })),
];

type Filter = 'All' | RequestStatus;

/**
 * `useSearchParams` opts a route into client rendering, which Next requires to
 * sit behind a Suspense boundary so the rest of the page can still prerender.
 */
export default function RequestsPage() {
  return (
    <React.Suspense fallback={<RequestsFallback />}>
      <RequestsView />
    </React.Suspense>
  );
}

function RequestsFallback() {
  return (
    <AdminShell section="Monitor" title="Pickup requests">
      <p style={{ margin: 0, fontSize: 14, color: '#677482' }}>Loading…</p>
    </AdminShell>
  );
}

function RequestsView() {
  const { theme } = useTheme();
  const params = useSearchParams();
  const initialQuery = params.get('q') ?? '';

  const [filter, setFilter] = React.useState<Filter>('All');
  const [query, setQuery] = React.useState(initialQuery);
  const [items, setItems] = React.useState<PickupRequestView[]>([]);
  const [total, setTotal] = React.useState(0);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [selected, setSelected] = React.useState<PickupRequestView | null>(null);
  const [shuttles, setShuttles] = React.useState<ShuttleStatusView[]>([]);

  // Keep the search box in step with the URL, so the top-bar search lands here.
  React.useEffect(() => {
    setQuery(params.get('q') ?? '');
  }, [params]);

  const load = React.useCallback(async () => {
    setLoading(true);
    try {
      setError(null);
      const page = await api.requests.list({
        limit: 200,
        ...(filter === 'All' ? {} : { status: filter }),
        ...(query.trim() === '' ? {} : { q: query.trim() }),
      });
      setItems(page.items);
      setTotal(page.total);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load requests.');
    } finally {
      setLoading(false);
    }
  }, [filter, query]);

  React.useEffect(() => {
    // Debounced so typing in the search box does not fire a query per keystroke.
    const timer = setTimeout(() => void load(), 250);
    return () => clearTimeout(timer);
  }, [load]);

  React.useEffect(() => {
    void api.fleet
      .statuses()
      .then(setShuttles)
      .catch(() => setShuttles([]));
  }, []);

  // A change elsewhere (a driver accepting, say) updates the row in place.
  useSocketEvent(
    'request:changed',
    React.useCallback(({ request }) => {
      setItems((previous) => {
        const index = previous.findIndex((r) => r.id === request.id);
        if (index === -1) return previous;
        const copy = [...previous];
        copy[index] = request;
        return copy;
      });
      setSelected((previous) => (previous?.id === request.id ? request : previous));
    }, []),
  );

  const openCount = items.filter((r) =>
    ['pending', 'accepted', 'arrived', 'boarding'].includes(r.status),
  ).length;

  return (
    <AdminShell
      section="Monitor"
      title="Pickup requests"
      badges={{ '/requests': openCount }}
      actions={
        <Button variant="secondary" height={34} onClick={() => void api.admin.exportRequests()}>
          Export CSV
        </Button>
      }
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <FilterChips options={FILTERS} value={filter} onChange={setFilter} />
        {query !== '' && (
          <span style={{ fontSize: fontSize.base, color: theme.fg3 }}>
            matching “{query}”
            <button
              type="button"
              onClick={() => setQuery('')}
              style={{
                marginLeft: 8,
                border: 0,
                background: 'transparent',
                color: brand.blue,
                cursor: 'pointer',
                fontSize: fontSize.sm,
              }}
            >
              clear
            </button>
          </span>
        )}
      </div>

      {error != null && <p style={{ margin: 0, color: brand.redText, fontSize: fontSize.md }}>{error}</p>}

      <DataTable
        columns={COLUMNS}
        emptyMessage={loading ? 'Loading…' : 'No requests match these filters.'}
        footer={`${items.length} of ${total} requests · click a row for details`}
        rows={items.map((request) => ({
          id: request.id,
          selected: selected?.id === request.id,
          onClick: () => setSelected(request),
          cells: [
            cell.text(request.code, { mono: true, color: brand.blue, bold: true }),
            cell.text(request.employeeName),
            cell.text(request.employeeDepartment ?? '—', { color: theme.fg2 }),
            cell.text(request.pickupStopName),
            cell.text(request.destinationStopName),
            cell.text(request.passengerCount, { mono: true }),
            cell.text(request.shuttleName ?? '—', {
              mono: true,
              color: request.shuttleName == null ? theme.fg3 : theme.fg,
            }),
            cell.text(humanizeEtaSec(request.etaSec), { mono: true }),
            cell.text(formatTime(request.requestedAt), { mono: true, color: theme.fg2 }),
            cell.pill(requestStatusLabel(request.status), requestTone(request.status)),
          ],
        }))}
      />

      {selected != null && (
        <RequestDrawer
          request={selected}
          shuttles={shuttles}
          onClose={() => setSelected(null)}
          onChanged={(next) => {
            setSelected(next);
            void load();
          }}
        />
      )}
    </AdminShell>
  );
}
