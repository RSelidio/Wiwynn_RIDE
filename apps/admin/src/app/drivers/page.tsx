'use client';

import React from 'react';
import { api, ApiRequestError, useAuth } from '@shuttle/client';
import { formatRelativeDay } from '@shuttle/shared-utils';
import { Button, Card, Label, TextInput, brand, useTheme } from '@shuttle/ui';
import { AdminShell } from '@/components/AdminShell';
import { DataTable, cell, type Column } from '@/components/DataTable';

const COLUMNS: Column[] = [
  { header: 'Driver', width: '1.4fr' },
  { header: 'ID', width: '100px' },
  { header: 'Email', width: '1.6fr' },
  { header: 'Phone', width: '1.2fr' },
  { header: 'Shuttle', width: '110px' },
  { header: 'On since', width: '140px' },
  { header: 'Trips (30d)', width: '110px', align: 'right' },
  { header: 'Status', width: '120px' },
  { header: 'Actions', width: '90px' },
];

type DriverRow = Awaited<ReturnType<typeof api.admin.drivers>>['items'][number];

export default function DriversPage() {
  const { theme } = useTheme();
  const { status } = useAuth();
  const [items, setItems] = React.useState<DriverRow[]>([]);
  const [total, setTotal] = React.useState(0);
  const [loading, setLoading] = React.useState(true);
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const [showForm, setShowForm] = React.useState(false);
  const [editingId, setEditingId] = React.useState<string | null>(null);
  const [saving, setSaving] = React.useState(false);
  const [form, setForm] = React.useState({ email: '', password: '', displayName: '', driverNo: '', phone: '', licenseNo: '', isActive: true });

  React.useEffect(() => {
    if (status === 'loading') return;
    if (status !== 'authenticated') {
      setLoading(false);
      return;
    }

    let cancelled = false;
    void (async () => {
      try {
        setLoadError(null);
        const page = await api.admin.drivers({ limit: 200 });
        if (cancelled) return;
        setItems(page.items);
        setTotal(page.total);
      } catch (error) {
        if (cancelled) return;
        setLoadError(
          error instanceof ApiRequestError ? error.message : 'Could not load drivers. Please try again.',
        );
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [status]);

  const saveDriver = async (event: React.FormEvent) => {
    event.preventDefault();
    if (saving) return;
    setSaving(true);
    setLoadError(null);
    try {
      const profile = {
        email: form.email.trim(),
        displayName: form.displayName.trim(),
        driverNo: form.driverNo.trim(),
        phone: form.phone.trim() || null,
        licenseNo: form.licenseNo.trim() || null,
      };
      if (editingId) {
        await api.admin.updateDriver(editingId, { ...profile, isActive: form.isActive, ...(form.password ? { password: form.password } : {}) });
      } else {
        await api.admin.createDriver({ ...profile, password: form.password });
      }
      setForm({ email: '', password: '', displayName: '', driverNo: '', phone: '', licenseNo: '', isActive: true });
      setShowForm(false);
      setEditingId(null);
      const page = await api.admin.drivers({ limit: 200 });
      setItems(page.items);
      setTotal(page.total);
    } catch (error) {
      setLoadError(error instanceof ApiRequestError ? error.message : 'Could not save driver.');
    } finally {
      setSaving(false);
    }
  };

  const onShift = items.filter((d) => d.isOnShift).length;

  return (
    <AdminShell
      section="Manage"
      title="Drivers"
      actions={<Button height={36} onClick={() => { setShowForm((shown) => !shown); setEditingId(null); setForm({ email: '', password: '', displayName: '', driverNo: '', phone: '', licenseNo: '', isActive: true }); }}>{showForm ? 'Cancel' : '+ Add driver'}</Button>}
    >
      {showForm && (
        <Card padding={18} style={{ marginBottom: 18 }}>
          <form onSubmit={saveDriver} style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 12, alignItems: 'end' }}>
            <div><Label>Company email</Label><TextInput type="email" value={form.email} onChange={(email) => setForm((current) => ({ ...current, email }))} placeholder="name@company.com" /></div>
            <div><Label>Full name</Label><TextInput value={form.displayName} onChange={(displayName) => setForm((current) => ({ ...current, displayName }))} placeholder="Driver name" maxLength={120} /></div>
            <div><Label>Driver ID</Label><TextInput value={form.driverNo} onChange={(driverNo) => setForm((current) => ({ ...current, driverNo }))} placeholder="Unique driver ID" maxLength={32} /></div>
            <div><Label>Phone (optional)</Label><TextInput value={form.phone} onChange={(phone) => setForm((current) => ({ ...current, phone }))} placeholder="Phone number" maxLength={40} /></div>
            <div><Label>License (optional)</Label><TextInput value={form.licenseNo} onChange={(licenseNo) => setForm((current) => ({ ...current, licenseNo }))} placeholder="License number" maxLength={80} /></div>
            <div><Label>{editingId ? 'New password (optional)' : 'Initial password'}</Label><TextInput type="password" value={form.password} onChange={(password) => setForm((current) => ({ ...current, password }))} placeholder="12+ chars, upper/lower/number" /></div>
            {editingId && <label style={{ display: 'flex', flexDirection: 'column', gap: 5, color: theme.fg3, fontSize: 11 }}>Account status<select value={form.isActive ? 'true' : 'false'} onChange={(event) => setForm((current) => ({ ...current, isActive: event.target.value === 'true' }))} style={{ height: 46, border: `1px solid ${theme.borderStrong}`, borderRadius: 6, padding: '0 10px', background: theme.surface, color: theme.fg }}><option value="true">Active</option><option value="false">Inactive</option></select></label>}
            <Button type="submit" height={46} disabled={saving || !form.email.trim() || !form.displayName.trim() || !form.driverNo.trim() || (!editingId && !form.password)}>{saving ? 'Saving…' : editingId ? 'Save changes' : 'Create driver'}</Button>
          </form>
          <p style={{ color: theme.fg3, fontSize: 12, marginBottom: 0 }}>{editingId ? 'Leave password blank to keep the current password. A changed password signs the driver out of existing sessions.' : 'Set a unique password with at least 12 characters, including uppercase, lowercase, and a number. Share it securely.'}</p>
        </Card>
      )}
      {loadError && <p role="alert" style={{ color: theme.fg }}>{loadError}</p>}
      <DataTable
        columns={COLUMNS}
        emptyMessage={loading ? 'Loading…' : loadError ?? 'No drivers enrolled.'}
        footer={`${items.length} of ${total} drivers · ${onShift} on shift`}
        rows={items.map((driver) => ({
          id: driver.id,
          cells: [
            cell.text(driver.displayName, { bold: true }),
            cell.text(driver.driverNo, { mono: true }),
            cell.text(driver.email, { color: theme.fg2 }),
            cell.text(driver.phone ?? '—', { mono: true, color: theme.fg2 }),
            cell.text(driver.currentShuttleName ?? '—', {
              mono: true,
              color: driver.currentShuttleName == null ? theme.fg3 : theme.fg,
            }),
            cell.text(
              driver.currentShiftStartedAt == null
                ? '—'
                : formatRelativeDay(driver.currentShiftStartedAt),
              { mono: true, color: theme.fg2 },
            ),
            cell.text(driver.tripsLast30d, { mono: true }),
            cell.pill(
              !driver.isActive ? 'Inactive' : driver.isOnShift ? 'On shift' : 'Off shift',
              !driver.isActive ? 'danger' : driver.isOnShift ? 'ok' : 'neutral',
            ),
            cell.node(<Button height={32} variant="secondary" onClick={() => { setForm({ email: driver.email, password: '', displayName: driver.displayName, driverNo: driver.driverNo, phone: driver.phone ?? '', licenseNo: driver.licenseNo ?? '', isActive: driver.isActive }); setEditingId(driver.id); setShowForm(true); setLoadError(null); }}>Edit</Button>),
          ],
        }))}
      />
      <p style={{ margin: 0, fontSize: 12, color: brand.blueText }}>
        Drivers sign in on the Expo driver app with the same company account.
      </p>
    </AdminShell>
  );
}
