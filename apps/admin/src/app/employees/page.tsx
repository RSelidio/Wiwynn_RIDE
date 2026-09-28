'use client';

import React from 'react';
import { api, ApiRequestError, useAuth } from '@shuttle/client';
import { formatRelativeDay } from '@shuttle/shared-utils';
import { Button, Card, Label, TextInput, useTheme } from '@shuttle/ui';
import { AdminShell } from '@/components/AdminShell';
import { DataTable, cell, type Column } from '@/components/DataTable';

const COLUMNS: Column[] = [
  { header: 'Employee', width: '1.2fr' },
  { header: 'Badge', width: '110px' },
  { header: 'RFID', width: '130px' },
  { header: 'Department', width: '1.4fr' },
  { header: 'Email', width: '1.6fr' },
  { header: 'Last request', width: '150px' },
  { header: 'Trips (30d)', width: '110px', align: 'right' },
  { header: 'Status', width: '110px' },
  { header: 'Actions', width: '90px' },
];

type EmployeeRow = Awaited<ReturnType<typeof api.admin.employees>>['items'][number];

export default function EmployeesPage() {
  const { theme } = useTheme();
  const { status } = useAuth();
  const [query, setQuery] = React.useState('');
  const [items, setItems] = React.useState<EmployeeRow[]>([]);
  const [total, setTotal] = React.useState(0);
  const [loading, setLoading] = React.useState(true);
  const [showForm, setShowForm] = React.useState(false);
  const [editingId, setEditingId] = React.useState<string | null>(null);
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [form, setForm] = React.useState({ email: '', password: '', displayName: '', badgeNo: '', rfidTag: '', department: '', isActive: true });

  React.useEffect(() => {
    if (status === 'loading') return;
    if (status !== 'authenticated') {
      setLoading(false);
      return;
    }
    // Server-side search: the directory is company-wide and will outgrow
    // anything that filters in the browser.
    const timer = setTimeout(() => {
      void (async () => {
        setLoading(true);
        try {
          setError(null);
          const page = await api.admin.employees({
            limit: 100,
            ...(query.trim() === '' ? {} : { q: query.trim() }),
          });
          setItems(page.items);
          setTotal(page.total);
        } catch (loadError) {
          setError(loadError instanceof Error ? loadError.message : 'Could not load employees.');
        } finally {
          setLoading(false);
        }
      })();
    }, 250);

    return () => clearTimeout(timer);
  }, [query, status]);

  const saveEmployee = async (event: React.FormEvent) => {
    event.preventDefault();
    if (saving) return;
    setSaving(true);
    setError(null);
    try {
      const profile = {
        email: form.email.trim(),
        displayName: form.displayName.trim(),
        badgeNo: form.badgeNo.trim(),
        rfidTag: form.rfidTag.trim() || null,
        department: form.department.trim() || null,
      };
      if (editingId) {
        await api.admin.updateEmployee(editingId, { ...profile, isActive: form.isActive, ...(form.password ? { password: form.password } : {}) });
      } else {
        await api.admin.createEmployee({ ...profile, password: form.password });
      }
      setForm({ email: '', password: '', displayName: '', badgeNo: '', rfidTag: '', department: '', isActive: true });
      setShowForm(false);
      setEditingId(null);
      const page = await api.admin.employees({ limit: 100, ...(query.trim() ? { q: query.trim() } : {}) });
      setItems(page.items);
      setTotal(page.total);
    } catch (saveError) {
      setError(saveError instanceof ApiRequestError ? saveError.message : 'Could not save employee.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <AdminShell
      section="Manage"
      title="Employees"
      actions={
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <div style={{ width: 260 }}>
            <TextInput value={query} onChange={setQuery} placeholder="Search name, badge, department…" height={34} />
          </div>
          <Button height={36} onClick={() => { setShowForm((shown) => !shown); setEditingId(null); setForm({ email: '', password: '', displayName: '', badgeNo: '', rfidTag: '', department: '', isActive: true }); }}>{showForm ? 'Cancel' : '+ Add employee'}</Button>
        </div>
      }
    >
      {showForm && (
        <Card padding={18} style={{ marginBottom: 18 }}>
          <form onSubmit={saveEmployee} style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 12, alignItems: 'end' }}>
            <div><Label>Company email</Label><TextInput type="email" value={form.email} onChange={(email) => setForm((current) => ({ ...current, email }))} placeholder="name@company.com" /></div>
            <div><Label>Full name</Label><TextInput value={form.displayName} onChange={(displayName) => setForm((current) => ({ ...current, displayName }))} placeholder="Employee name" maxLength={120} /></div>
            <div><Label>Employee badge</Label><TextInput value={form.badgeNo} onChange={(badgeNo) => setForm((current) => ({ ...current, badgeNo }))} placeholder="Unique badge ID" maxLength={32} /></div>
            <div><Label>RFID tag (optional)</Label><TextInput value={form.rfidTag} onChange={(rfidTag) => setForm((current) => ({ ...current, rfidTag }))} placeholder="Scan or enter tag UID" maxLength={128} /></div>
            <div><Label>Department (optional)</Label><TextInput value={form.department} onChange={(department) => setForm((current) => ({ ...current, department }))} placeholder="Department" maxLength={120} /></div>
            <div><Label>{editingId ? 'New password (optional)' : 'Initial password'}</Label><TextInput type="password" value={form.password} onChange={(password) => setForm((current) => ({ ...current, password }))} placeholder="12+ chars, upper/lower/number" /></div>
            {editingId && <label style={{ display: 'flex', flexDirection: 'column', gap: 5, color: theme.fg3, fontSize: 11 }}>Account status<select value={form.isActive ? 'true' : 'false'} onChange={(event) => setForm((current) => ({ ...current, isActive: event.target.value === 'true' }))} style={{ height: 46, border: `1px solid ${theme.borderStrong}`, borderRadius: 6, padding: '0 10px', background: theme.surface, color: theme.fg }}><option value="true">Active</option><option value="false">Inactive</option></select></label>}
            <Button type="submit" height={46} disabled={saving || !form.email.trim() || !form.displayName.trim() || !form.badgeNo.trim() || (!editingId && !form.password)}>{saving ? 'Saving…' : editingId ? 'Save changes' : 'Create employee'}</Button>
          </form>
          <p style={{ color: theme.fg3, fontSize: 12, marginBottom: 0 }}>{editingId ? 'Leave password blank to keep the current password. A changed password signs the employee out of existing sessions.' : 'Set a unique password with at least 12 characters, including uppercase, lowercase, and a number. Share it with the employee securely.'}</p>
        </Card>
      )}
      {error && <p role="alert" style={{ color: theme.fg }}>{error}</p>}
      <DataTable
        columns={COLUMNS}
        emptyMessage={loading ? 'Loading…' : error ?? 'No employees match that search.'}
        footer={`${items.length} of ${total} employees enrolled`}
        rows={items.map((employee) => ({
          id: employee.id,
          cells: [
            cell.text(employee.displayName, { bold: true }),
            cell.text(employee.badgeNo, { mono: true }),
            cell.text(employee.rfidTag ?? '—', { mono: true, color: employee.rfidTag == null ? theme.fg3 : theme.fg2 }),
            cell.text(employee.department ?? '—', { color: theme.fg2 }),
            cell.text(employee.email, { color: theme.fg2 }),
            cell.text(
              employee.lastRequestAt == null ? 'never' : formatRelativeDay(employee.lastRequestAt),
              { mono: true, color: employee.lastRequestAt == null ? theme.fg3 : theme.fg2 },
            ),
            cell.text(employee.tripsLast30d, { mono: true }),
            cell.pill(employee.isActive ? 'Active' : 'Inactive', employee.isActive ? 'ok' : 'neutral'),
            cell.node(<Button height={32} variant="secondary" onClick={() => { setForm({ email: employee.email, password: '', displayName: employee.displayName, badgeNo: employee.badgeNo, rfidTag: employee.rfidTag ?? '', department: employee.department ?? '', isActive: employee.isActive }); setEditingId(employee.id); setShowForm(true); setError(null); }}>Edit</Button>),
          ],
        }))}
      />
    </AdminShell>
  );
}
