'use client';

import React from 'react';
import { api, ApiRequestError } from '@shuttle/client';
import type { SystemSettings } from '@shuttle/shared-types';
import { Card, Mono, Toast, Toggle, brand, fontSize, useTheme, weight } from '@shuttle/ui';
import { AdminShell } from '@/components/AdminShell';

/** The dispatch switches, matching the approved settings page. */
const TOGGLES: Array<{ key: keyof SystemSettings; label: string; description: string }> = [
  {
    key: 'autoAssign',
    label: 'Auto-assign pending requests',
    description: 'The nearest online shuttle with free seats takes the request automatically.',
  },
  {
    key: 'requireGateLog',
    label: 'Require gate check-in',
    description: 'Guards must check shuttles in and out at the Main Building gate.',
  },
  {
    key: 'pushEtaEnabled',
    label: 'ETA notifications',
    description: 'Notify employees shortly before their shuttle arrives.',
  },
  {
    key: 'nightService',
    label: 'Night service',
    description: 'Keep one shuttle on call after 22:00.',
  },
];

/** Numeric thresholds, with the step and unit each one is edited in. */
const THRESHOLDS: Array<{
  key: keyof SystemSettings;
  label: string;
  description: string;
  step: number;
  unit: string;
  min: number;
  max: number;
}> = [
  {
    key: 'gpsGapAlertSec',
    label: 'GPS gap alert',
    description: 'Seconds without a fix before a shuttle is flagged as out of contact.',
    step: 5,
    unit: 's',
    min: 5,
    max: 600,
  },
  {
    key: 'longWaitAlertMin',
    label: 'Long-wait alert',
    description: 'Minutes an employee may wait before the request is escalated to admins.',
    step: 1,
    unit: 'min',
    min: 1,
    max: 120,
  },
  {
    key: 'stopGeofenceM',
    label: 'Stop geofence',
    description: 'Metres around a stop that count as having arrived.',
    step: 10,
    unit: 'm',
    min: 5,
    max: 1000,
  },
  {
    key: 'requestExpiryMin',
    label: 'Request expiry',
    description: 'Minutes before an unassigned request expires and the employee is told.',
    step: 5,
    unit: 'min',
    min: 1,
    max: 240,
  },
  {
    key: 'approachingNoticeMin',
    label: 'Approaching notice',
    description: 'Minutes out at which the "arriving soon" notification fires.',
    step: 1,
    unit: 'min',
    min: 1,
    max: 30,
  },
];

export default function SettingsPage() {
  const { theme } = useTheme();
  const [settings, setSettings] = React.useState<SystemSettings | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [toast, setToast] = React.useState<string | null>(null);

  const flash = (message: string) => {
    setToast(message);
    setTimeout(() => setToast(null), 2_600);
  };

  React.useEffect(() => {
    void api.admin
      .settings()
      .then(setSettings)
      .catch(() => flash('Could not load settings'));
  }, []);

  /**
   * Write one field.
   *
   * Applied optimistically so a toggle feels instant, and rolled back if the
   * server rejects it — a switch that silently springs back with no explanation
   * is worse than a slower one.
   */
  const save = async (patch: Partial<SystemSettings>, label: string) => {
    if (settings == null || busy) return;

    const previous = settings;
    setSettings({ ...settings, ...patch });
    setBusy(true);

    try {
      setSettings(await api.admin.saveSettings(patch));
      flash(`${label} saved`);
    } catch (err) {
      setSettings(previous);
      flash(err instanceof ApiRequestError ? err.message : `Could not save ${label}`);
    } finally {
      setBusy(false);
    }
  };

  if (settings == null) {
    return (
      <AdminShell section="Insights" title="Settings">
        <p style={{ color: theme.fg3, fontSize: fontSize.md }}>Loading…</p>
      </AdminShell>
    );
  }

  return (
    <AdminShell section="Insights" title="Settings">
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 16, alignContent: 'start' }}>
        <Card padding={20}>
          <h2 style={{ margin: '0 0 10px', fontSize: fontSize.lg, fontWeight: weight.semibold }}>Dispatch</h2>

          {TOGGLES.map((option) => (
            <div
              key={String(option.key)}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 14,
                padding: '12px 0',
                borderTop: `1px solid ${theme.sunken}`,
              }}
            >
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 13.5, fontWeight: weight.medium }}>{option.label}</div>
                <div style={{ fontSize: fontSize.sm, color: theme.fg3, marginTop: 2 }}>
                  {option.description}
                </div>
              </div>
              <Toggle
                checked={settings[option.key] === true}
                onChange={(next) => void save({ [option.key]: next } as Partial<SystemSettings>, option.label)}
              />
            </div>
          ))}
        </Card>

        <Card padding={20}>
          <h2 style={{ margin: '0 0 10px', fontSize: fontSize.lg, fontWeight: weight.semibold }}>Thresholds</h2>

          {THRESHOLDS.map((threshold) => {
            const value = Number(settings[threshold.key]);

            return (
              <div
                key={String(threshold.key)}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 12,
                  padding: '10px 0',
                  borderTop: `1px solid ${theme.sunken}`,
                }}
              >
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 13.5, fontWeight: weight.medium }}>{threshold.label}</div>
                  <div style={{ fontSize: fontSize.sm, color: theme.fg3, marginTop: 2 }}>
                    {threshold.description}
                  </div>
                </div>

                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    border: `1px solid ${theme.borderStrong}`,
                    borderRadius: 6,
                    overflow: 'hidden',
                    flex: 'none',
                  }}
                >
                  <StepButton
                    label="Decrease"
                    disabled={busy || value <= threshold.min}
                    onClick={() =>
                      void save(
                        { [threshold.key]: Math.max(threshold.min, value - threshold.step) } as Partial<SystemSettings>,
                        threshold.label,
                      )
                    }
                  >
                    −
                  </StepButton>

                  <Mono size={fontSize.base} bold style={{ width: 76, textAlign: 'center' }}>
                    {value} {threshold.unit}
                  </Mono>

                  <StepButton
                    label="Increase"
                    disabled={busy || value >= threshold.max}
                    onClick={() =>
                      void save(
                        { [threshold.key]: Math.min(threshold.max, value + threshold.step) } as Partial<SystemSettings>,
                        threshold.label,
                      )
                    }
                  >
                    +
                  </StepButton>
                </div>
              </div>
            );
          })}

          <p style={{ margin: '14px 0 0', fontSize: fontSize.sm, color: theme.fg3, lineHeight: 1.5 }}>
            Changes apply immediately — the backend re-reads these within ten seconds, so the next GPS
            fix is evaluated against the new values. No restart needed.
          </p>
        </Card>
      </div>

      <Card padding={20} style={{ alignSelf: 'start' }}>
        <h2 style={{ margin: '0 0 10px', fontSize: fontSize.lg, fontWeight: weight.semibold }}>
          Authentication
        </h2>
        <p style={{ margin: 0, fontSize: fontSize.base, color: theme.fg2, lineHeight: 1.6 }}>
          Sign-in currently uses local company accounts. Microsoft Entra ID single sign-on is
          supported by the backend but stays disabled until the tenant details are configured and
          company IT approves it — see{' '}
          <Mono size={fontSize.sm} color={brand.blueText}>
            docs/authentication.md
          </Mono>
          .
        </p>
      </Card>

      <Toast message={toast ?? ''} visible={toast != null} />
    </AdminShell>
  );
}

function StepButton({
  children,
  onClick,
  disabled,
  label,
}: {
  children: React.ReactNode;
  onClick: () => void;
  disabled: boolean;
  label: string;
}) {
  const { theme } = useTheme();
  return (
    <button
      type="button"
      aria-label={label}
      onClick={onClick}
      disabled={disabled}
      style={{
        width: 32,
        height: 32,
        border: 0,
        background: theme.sunken,
        cursor: disabled ? 'not-allowed' : 'pointer',
        fontSize: 16,
        color: theme.fg2,
        opacity: disabled ? 0.45 : 1,
      }}
    >
      {children}
    </button>
  );
}
