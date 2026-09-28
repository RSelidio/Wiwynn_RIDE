'use client';

import React from 'react';
import { api } from '@shuttle/client';
import type { TripView } from '@shuttle/shared-types';
import { formatDistance, formatDuration, formatTime, tripStatusLabel } from '@shuttle/shared-utils';
import { Button, brand, fontSize, useTheme } from '@shuttle/ui';
import { AdminShell } from '@/components/AdminShell';
import { DataTable, cell, type Column } from '@/components/DataTable';

const COLUMNS: Column[] = [
  { header: 'Trip', width: '100px' },
  { header: 'Shuttle', width: '110px' },
  { header: 'Driver', width: '1fr' },
  { header: 'Route', width: '1.4fr' },
  { header: 'Depart', width: '80px' },
  { header: 'Arrive', width: '80px' },
  { header: 'Duration', width: '90px' },
  { header: 'Pax', width: '60px' },
  { header: 'Distance', width: '90px' },
  { header: 'Status', width: '120px' },
];

export default function TripsPage() {
  const { theme } = useTheme();
  const [items, setItems] = React.useState<TripView[]>([]);
  const [total, setTotal] = React.useState(0);
  const [loading, setLoading] = React.useState(true);

  React.useEffect(() => {
    void (async () => {
      try {
        const page = await api.admin.trips({ limit: 200 });
        setItems(page.items);
        setTotal(page.total);
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  const passengers = items.reduce((sum, trip) => sum + trip.passengerCount, 0);

  return (
    <AdminShell
      section="Monitor"
      title="Trips today"
      actions={
        <Button variant="secondary" height={34} onClick={() => void api.admin.exportTrips()}>
          Export CSV
        </Button>
      }
    >
      <DataTable
        columns={COLUMNS}
        emptyMessage={loading ? 'Loading…' : 'No trips recorded in this window.'}
        footer={`${items.length} of ${total} trips · ${passengers} passengers`}
        rows={items.map((trip) => {
          const durationSec =
            trip.arrivedAt == null
              ? null
              : (new Date(trip.arrivedAt).getTime() - new Date(trip.departedAt).getTime()) / 1000;

          return {
            id: trip.id,
            cells: [
              cell.text(trip.code, { mono: true, color: brand.blue, bold: true }),
              cell.text(trip.shuttleName, { mono: true }),
              cell.text(trip.driverName),
              cell.text(`${trip.originStopName} → ${trip.destinationStopName}`),
              cell.text(formatTime(trip.departedAt), { mono: true }),
              cell.text(trip.arrivedAt == null ? '—' : formatTime(trip.arrivedAt), {
                mono: true,
                color: trip.arrivedAt == null ? theme.fg3 : theme.fg,
              }),
              cell.text(formatDuration(durationSec), { mono: true }),
              cell.text(trip.passengerCount, { mono: true }),
              cell.text(formatDistance(trip.distanceM), { mono: true, color: theme.fg2 }),
              cell.pill(
                tripStatusLabel(trip.status),
                trip.status === 'completed' ? 'neutral' : trip.status === 'cancelled' ? 'danger' : 'info',
              ),
            ],
          };
        })}
      />
    </AdminShell>
  );
}
