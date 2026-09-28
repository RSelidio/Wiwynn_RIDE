/**
 * Shared React components for the two web surfaces (employee PWA, admin).
 *
 * Styling is inline, mirroring the approved UI sample, so the components carry
 * their own appearance into either app without a CSS build step. Interaction
 * states that inline styles cannot express (:hover, :focus-visible) live in each
 * app's `globals.css` against the `.sh-*` class names set here.
 */

'use client';

import React from 'react';
import {
  brand,
  font,
  fontSize,
  lightTheme,
  radius,
  shadow,
  themeFor,
  toneFor,
  weight,
  type Theme,
  type ThemeName,
  type ToneName,
} from './tokens';

// ─────────────────────────────────────────────────────────────────────────────
// Theme context
// ─────────────────────────────────────────────────────────────────────────────

interface ThemeContextValue {
  theme: Theme;
  name: ThemeName;
  setName: (name: ThemeName) => void;
}

const ThemeContext = React.createContext<ThemeContextValue>({
  theme: lightTheme,
  name: 'light',
  setName: () => {},
});

export function ThemeProvider({
  children,
  initial = 'light',
}: {
  children: React.ReactNode;
  initial?: ThemeName;
}) {
  const [name, setName] = React.useState<ThemeName>(initial);
  const [ready, setReady] = React.useState(false);

  React.useEffect(() => {
    try {
      const stored = window.localStorage.getItem('shuttle-theme');
      if (stored === 'light' || stored === 'dark') setName(stored);
    } catch {
      // Storage can be unavailable in private browsing; the in-memory toggle still works.
    }
    setReady(true);
  }, []);

  React.useEffect(() => {
    if (!ready) return;
    const theme = themeFor(name);
    const root = document.documentElement;
    root.dataset.theme = name;
    root.style.colorScheme = theme.colorScheme;
    root.style.setProperty('--page', theme.page);
    root.style.setProperty('--surface', theme.surface);
    root.style.setProperty('--sunken', theme.sunken);
    root.style.setProperty('--border', theme.border);
    root.style.setProperty('--border-strong', theme.borderStrong);
    root.style.setProperty('--fg', theme.fg);
    root.style.setProperty('--fg-2', theme.fg2);
    root.style.setProperty('--fg-3', theme.fg3);
    root.style.setProperty('--accent', theme.accent);
    root.style.setProperty('--accent-btn', theme.accentBtn);
    try {
      window.localStorage.setItem('shuttle-theme', name);
    } catch {
      // Theme remains active for this page load even if it cannot be persisted.
    }
  }, [name, ready]);
  const value = React.useMemo(() => ({ theme: themeFor(name), name, setName }), [name]);
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  return React.useContext(ThemeContext);
}

/** Theme switch shared by every web page chrome. */
export function ThemeToggle({ compact = false }: { compact?: boolean }) {
  const { name, setName, theme } = useTheme();
  const next = name === 'dark' ? 'light' : 'dark';
  return (
    <button
      type="button"
      onClick={() => setName(next)}
      aria-label={`Switch to ${next} mode`}
      title={`Switch to ${next} mode`}
      style={{
        height: 36,
        padding: compact ? '0 10px' : '0 12px',
        display: 'inline-flex',
        alignItems: 'center',
        gap: 7,
        border: `1px solid ${theme.borderStrong}`,
        borderRadius: radius.md,
        background: theme.surface,
        color: theme.fg,
        font: `500 ${fontSize.sm}px ${font.sans}`,
        cursor: 'pointer',
        whiteSpace: 'nowrap',
      }}
    >
      <span aria-hidden="true">{name === 'dark' ? '☀' : '☾'}</span>
      {name === 'dark' ? 'Light' : 'Dark'}
    </button>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Primitives
// ─────────────────────────────────────────────────────────────────────────────

/** Tabular monospace text — IDs, plates, times, anything that should align. */
export function Mono({
  children,
  size = fontSize.base,
  color,
  bold,
  style,
}: {
  children: React.ReactNode;
  size?: number;
  color?: string;
  bold?: boolean;
  style?: React.CSSProperties;
}) {
  return (
    <span
      style={{
        fontFamily: font.mono,
        fontSize: size,
        fontWeight: bold ? weight.semibold : weight.medium,
        fontVariantNumeric: 'tabular-nums',
        ...(color ? { color } : {}),
        ...style,
      }}
    >
      {children}
    </span>
  );
}

/** Uppercase field label, as used above every value in the sample. */
export function Label({
  children,
  color,
  style,
}: {
  children: React.ReactNode;
  color?: string;
  style?: React.CSSProperties;
}) {
  const { theme } = useTheme();
  return (
    <span
      style={{
        fontSize: 10.5,
        fontWeight: weight.semibold,
        letterSpacing: '.08em',
        textTransform: 'uppercase',
        color: color ?? theme.fg3,
        ...style,
      }}
    >
      {children}
    </span>
  );
}

/** Status pill: coloured dot plus label. The dot carries the meaning. */
export function StatusPill({
  label,
  tone = 'neutral',
  showDot = true,
  style,
}: {
  label: string;
  tone?: ToneName;
  showDot?: boolean;
  style?: React.CSSProperties;
}) {
  const { name } = useTheme();
  const t = toneFor(tone, name);
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 5,
        fontSize: 11.5,
        fontWeight: weight.medium,
        padding: '2px 8px',
        borderRadius: radius.pill,
        background: t.bg,
        color: t.fg,
        whiteSpace: 'nowrap',
        ...style,
      }}
    >
      {showDot && (
        <span
          style={{ width: 6, height: 6, borderRadius: '50%', background: t.dot, flex: 'none' }}
        />
      )}
      {label}
    </span>
  );
}

/** The pulsing "Live" indicator in every app header. */
export function LiveDot({ label = 'Live' }: { label?: string }) {
  const { theme } = useTheme();
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        fontSize: fontSize.xs,
        color: theme.fg3,
      }}
    >
      <span
        className="sh-live-dot"
        style={{
          width: 7,
          height: 7,
          borderRadius: '50%',
          background: brand.green,
          boxShadow: `0 0 0 3px rgba(128,208,0,.18)`,
        }}
      />
      {label}
    </span>
  );
}

export function Avatar({
  name,
  size = 30,
  subtitle,
}: {
  name: string;
  size?: number;
  subtitle?: string;
}) {
  const { theme } = useTheme();
  const text = name
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0])
    .join('')
    .toUpperCase();

  const chip = (
    <span
      style={{
        width: size,
        height: size,
        borderRadius: '50%',
        background: brand.avatarBg,
        color: brand.avatarFg,
        fontSize: size <= 30 ? 11 : 12,
        fontWeight: weight.semibold,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        flex: 'none',
      }}
    >
      {text || '?'}
    </span>
  );

  if (!subtitle) return chip;

  return (
    <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      {chip}
      <span style={{ display: 'flex', flexDirection: 'column', lineHeight: 1.2 }}>
        <span style={{ fontSize: 12.5, fontWeight: weight.semibold, color: theme.fg }}>{name}</span>
        <span style={{ fontSize: fontSize.xs, color: theme.fg3 }}>{subtitle}</span>
      </span>
    </span>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Surfaces
// ─────────────────────────────────────────────────────────────────────────────

export function Card({
  children,
  padding = 16,
  elevated,
  accentBorder,
  onClick,
  style,
}: {
  children: React.ReactNode;
  padding?: number | string;
  elevated?: boolean;
  /** Draw the border in Wiwynn Blue — for a card that wants action. */
  accentBorder?: boolean;
  onClick?: () => void;
  style?: React.CSSProperties;
}) {
  const { theme } = useTheme();
  return (
    <div
      onClick={onClick}
      role={onClick ? 'button' : undefined}
      tabIndex={onClick ? 0 : undefined}
      onKeyDown={
        onClick
          ? (e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                onClick();
              }
            }
          : undefined
      }
      className={onClick ? 'sh-card sh-clickable' : 'sh-card'}
      style={{
        background: theme.surface,
        border: `1px solid ${accentBorder ? brand.blue : theme.border}`,
        borderRadius: radius.xl,
        padding,
        boxShadow: elevated ? shadow.raised : shadow.card,
        ...(onClick ? { cursor: 'pointer' } : {}),
        ...style,
      }}
    >
      {children}
    </div>
  );
}

/** KPI tile: label, big numeral with unit, sub-line. */
export function StatTile({
  label,
  value,
  unit,
  sub,
  subColor,
  onClick,
}: {
  label: string;
  value: string | number;
  unit?: string;
  sub?: string;
  subColor?: string;
  onClick?: () => void;
}) {
  const { theme } = useTheme();
  return (
    <Card padding={16} {...(onClick ? { onClick } : {})}>
      <div
        style={{
          fontSize: fontSize.xs,
          fontWeight: weight.semibold,
          color: theme.fg3,
          letterSpacing: '.06em',
          textTransform: 'uppercase',
          marginBottom: 8,
        }}
      >
        {label}
      </div>
      <div
        style={{
          fontSize: fontSize.stat,
          fontWeight: weight.semibold,
          color: brand.blueDeep,
          lineHeight: 1,
          fontVariantNumeric: 'tabular-nums',
        }}
      >
        {value}
        {unit ? (
          <span
            style={{
              fontSize: fontSize.md,
              color: theme.fg3,
              fontWeight: weight.medium,
              marginLeft: 4,
            }}
          >
            {unit}
          </span>
        ) : null}
      </div>
      {sub ? (
        <div
          style={{
            fontSize: fontSize.sm,
            color: subColor ?? theme.fg3,
            marginTop: 8,
            fontFamily: font.mono,
          }}
        >
          {sub}
        </div>
      ) : null}
    </Card>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Controls
// ─────────────────────────────────────────────────────────────────────────────

export type ButtonVariant = 'primary' | 'secondary' | 'danger' | 'success' | 'ghost';

export function Button({
  children,
  onClick,
  variant = 'primary',
  disabled,
  height = 48,
  full,
  type = 'button',
  style,
}: {
  children: React.ReactNode;
  onClick?: () => void;
  variant?: ButtonVariant;
  disabled?: boolean;
  height?: number;
  full?: boolean;
  type?: 'button' | 'submit';
  style?: React.CSSProperties;
}) {
  const { theme } = useTheme();

  const variants: Record<ButtonVariant, React.CSSProperties> = {
    primary: { background: theme.accentBtn, color: '#fff', border: 0 },
    // Signal green: reserved for the driver's accept action.
    success: { background: brand.green, color: '#001f30', border: 0 },
    secondary: {
      background: theme.surface,
      color: theme.fg,
      border: `1px solid ${theme.borderStrong}`,
    },
    danger: {
      background: theme.surface,
      color: brand.red,
      border: `1px solid ${theme.borderStrong}`,
    },
    ghost: { background: 'transparent', color: theme.accent, border: 0 },
  };

  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      className={`sh-btn sh-btn-${variant}`}
      style={{
        height,
        padding: '0 20px',
        borderRadius: radius.md,
        fontFamily: font.sans,
        fontSize: fontSize.md,
        fontWeight: weight.semibold,
        cursor: disabled ? 'not-allowed' : 'pointer',
        opacity: disabled ? 0.45 : 1,
        width: full ? '100%' : undefined,
        ...variants[variant],
        ...style,
      }}
    >
      {children}
    </button>
  );
}

/** Pill-shaped filter chip row, as on the admin tables and guard log. */
export function FilterChips<T extends string>({
  options,
  value,
  onChange,
}: {
  options: readonly { value: T; label: string }[];
  value: T;
  onChange: (value: T) => void;
}) {
  const { theme, name } = useTheme();
  return (
    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
      {options.map((opt) => {
        const on = opt.value === value;
        return (
          <button
            key={opt.value}
            type="button"
            onClick={() => onChange(opt.value)}
            className="sh-chip"
            style={{
              height: 30,
              padding: '0 12px',
              borderRadius: radius.pill,
              border: `1px solid ${on ? theme.accentBtn : theme.borderStrong}`,
              background: on ? (name === 'dark' ? '#0f2a40' : brand.bluePale) : 'transparent',
              color: on ? theme.accent : theme.fg2,
              fontFamily: font.sans,
              fontSize: fontSize.sm,
              fontWeight: weight.medium,
              cursor: 'pointer',
            }}
          >
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}

/** Two-option segmented control — the guard tablet's Light / Dark switch. */
export function SegmentedControl<T extends string>({
  options,
  value,
  onChange,
}: {
  options: readonly { value: T; label: string }[];
  value: T;
  onChange: (value: T) => void;
}) {
  const { theme } = useTheme();
  return (
    <div
      style={{
        display: 'flex',
        border: `1px solid ${theme.borderStrong}`,
        borderRadius: radius.md,
        overflow: 'hidden',
      }}
    >
      {options.map((opt) => {
        const on = opt.value === value;
        return (
          <button
            key={opt.value}
            type="button"
            onClick={() => onChange(opt.value)}
            style={{
              height: 32,
              padding: '0 12px',
              border: 0,
              cursor: 'pointer',
              fontFamily: font.sans,
              fontSize: fontSize.sm,
              fontWeight: weight.medium,
              background: on ? theme.accentBtn : 'transparent',
              color: on ? '#fff' : theme.fg3,
            }}
          >
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}

/** −/+ stepper for a passenger count. */
export function Stepper({
  value,
  onChange,
  min = 0,
  max = 12,
  size = 48,
}: {
  value: number;
  onChange: (value: number) => void;
  min?: number;
  max?: number;
  size?: number;
}) {
  const { theme } = useTheme();
  const btn: React.CSSProperties = {
    width: size,
    height: size,
    border: 0,
    background: theme.sunken,
    fontFamily: font.sans,
    fontSize: 22,
    fontWeight: weight.medium,
    color: theme.fg2,
    cursor: 'pointer',
  };
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        border: `1px solid ${theme.borderStrong}`,
        borderRadius: radius.lg,
        background: theme.surface,
        overflow: 'hidden',
        width: 'fit-content',
      }}
    >
      <button
        type="button"
        style={btn}
        onClick={() => onChange(Math.max(min, value - 1))}
        aria-label="Decrease"
        disabled={value <= min}
      >
        −
      </button>
      <span
        style={{
          width: 64,
          textAlign: 'center',
          fontFamily: font.mono,
          fontSize: 20,
          fontWeight: weight.semibold,
          color: theme.fg,
        }}
      >
        {value}
      </span>
      <button
        type="button"
        style={btn}
        onClick={() => onChange(Math.min(max, value + 1))}
        aria-label="Increase"
        disabled={value >= max}
      >
        +
      </button>
    </div>
  );
}

export function Toggle({
  checked,
  onChange,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  const { theme } = useTheme();
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      style={{
        width: 40,
        height: 22,
        borderRadius: 11,
        background: checked ? theme.accentBtn : theme.borderStrong,
        position: 'relative',
        flex: 'none',
        border: 0,
        padding: 0,
        cursor: 'pointer',
        transition: 'background 140ms ease',
      }}
    >
      <span
        style={{
          position: 'absolute',
          top: 3,
          left: checked ? 21 : 3,
          width: 16,
          height: 16,
          borderRadius: '50%',
          background: '#fff',
          boxShadow: '0 1px 2px rgba(0,0,0,.25)',
          transition: 'left 140ms ease',
        }}
      />
    </button>
  );
}

export function TextInput({
  value,
  onChange,
  onCommit,
  placeholder,
  height = 48,
  maxLength,
  type = 'text',
  step,
  min,
  max,
  style,
}: {
  value: string | number;
  onChange: (value: string) => void;
  /**
   * Called on blur and on Enter. For fields that persist to the server, so a
   * write happens once the user is done rather than on every keystroke.
   */
  onCommit?: (value: string) => void;
  placeholder?: string;
  height?: number;
  maxLength?: number;
  type?: 'text' | 'time' | 'number' | 'password' | 'email';
  step?: string | number;
  min?: number;
  max?: number;
  style?: React.CSSProperties;
}) {
  const { theme } = useTheme();
  return (
    <input
      type={type}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      onBlur={onCommit == null ? undefined : (e) => onCommit(e.target.value)}
      onKeyDown={
        onCommit == null
          ? undefined
          : (e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                onCommit(e.currentTarget.value);
                e.currentTarget.blur();
              }
            }
      }
      placeholder={placeholder}
      maxLength={maxLength}
      step={step}
      min={min}
      max={max}
      className="sh-input"
      style={{
        height,
        padding: '0 14px',
        border: `1px solid ${theme.borderStrong}`,
        borderRadius: radius.lg,
        background: theme.surface,
        color: theme.fg,
        fontFamily: type === 'time' || type === 'number' ? font.mono : font.sans,
        fontSize: fontSize.md,
        outline: 'none',
        width: '100%',
        boxSizing: 'border-box',
        colorScheme: theme.colorScheme,
        ...style,
      }}
    />
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Composites
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Seat occupancy bar. Filled cells are taken seats, so a glance reads
 * "how full" without the numeral.
 */
export function SeatBar({
  occupied,
  capacity,
  height = 6,
}: {
  occupied: number;
  capacity: number;
  height?: number;
}) {
  const { theme } = useTheme();
  return (
    <div style={{ display: 'flex', gap: 2 }} aria-label={`${occupied} of ${capacity} seats taken`}>
      {Array.from({ length: Math.max(0, capacity) }, (_, i) => (
        <span
          key={i}
          style={{
            flex: 1,
            height,
            borderRadius: 1,
            background: i < occupied ? brand.blue : theme.border,
          }}
        />
      ))}
    </div>
  );
}

/** Requested → Accepted → Arrived → Picked up progress rail. */
export function ProgressSteps({
  steps,
  currentIndex,
}: {
  steps: readonly string[];
  currentIndex: number;
}) {
  const { theme } = useTheme();
  return (
    <div>
      <div style={{ display: 'flex', gap: 4 }}>
        {steps.map((s, i) => (
          <div
            key={s}
            style={{
              flex: 1,
              height: 4,
              borderRadius: 2,
              background:
                i < currentIndex ? brand.blue : i === currentIndex ? brand.blueMuted : theme.borderStrong,
            }}
          />
        ))}
      </div>
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          marginTop: 6,
          fontSize: fontSize.xs,
          color: theme.fg3,
        }}
      >
        {steps.map((s, i) => (
          <span
            key={s}
            style={
              i === currentIndex
                ? { color: theme.accentBtn, fontWeight: weight.semibold }
                : undefined
            }
          >
            {s}
          </span>
        ))}
      </div>
    </div>
  );
}

/** Pickup → destination rail with a circle and a square terminus. */
export function RouteRail({
  pickup,
  destination,
  meta,
  gap = 18,
}: {
  pickup: string;
  destination: string;
  meta?: string;
  gap?: number;
}) {
  const { theme } = useTheme();
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '16px 1fr', columnGap: 14 }}>
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', paddingTop: 5 }}>
        <span
          style={{
            width: 10,
            height: 10,
            borderRadius: '50%',
            border: `2px solid ${brand.blue}`,
            background: theme.surface,
          }}
        />
        <span style={{ flex: 1, width: 2, background: theme.borderStrong, margin: '4px 0' }} />
        <span style={{ width: 10, height: 10, borderRadius: 2, background: brand.blue }} />
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap }}>
        <div>
          <div style={{ fontSize: fontSize.xs, color: theme.fg3 }}>Pickup</div>
          <div style={{ fontSize: fontSize.lg, fontWeight: weight.semibold, color: theme.fg }}>
            {pickup}
          </div>
        </div>
        <div>
          <div style={{ fontSize: fontSize.xs, color: theme.fg3 }}>Destination</div>
          <div style={{ fontSize: fontSize.lg, fontWeight: weight.semibold, color: theme.fg }}>
            {destination}
            {meta ? (
              <Mono size={fontSize.xs} color={theme.fg3} style={{ marginLeft: 6 }}>
                · {meta}
              </Mono>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
}

/** Time-stamped event list — request timeline, admin event log, driver log. */
export function Timeline({
  entries,
}: {
  entries: readonly { time: string; text: string; color?: string }[];
}) {
  const { theme } = useTheme();
  if (entries.length === 0) {
    return <div style={{ fontSize: fontSize.sm, color: theme.fg3 }}>No activity yet.</div>;
  }
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10, fontSize: 12.5 }}>
      {entries.map((e, i) => (
        <div key={`${e.time}-${i}`} style={{ display: 'flex', gap: 10 }}>
          <Mono size={12.5} color={theme.fg4} style={{ width: 44, flex: 'none' }}>
            {e.time}
          </Mono>
          <span style={{ color: e.color ?? theme.fg }}>{e.text}</span>
        </div>
      ))}
    </div>
  );
}

export function EmptyState({ message }: { message: string }) {
  const { theme } = useTheme();
  return (
    <div
      style={{
        padding: '28px 16px',
        textAlign: 'center',
        fontSize: 12.5,
        color: theme.fg3,
      }}
    >
      {message}
    </div>
  );
}

/** Transient confirmation, matching the sample's centred toast. */
export function Toast({
  message,
  visible,
  position = 'bottom',
}: {
  message: string;
  visible: boolean;
  position?: 'top' | 'bottom';
}) {
  const { theme } = useTheme();
  if (!visible) return null;
  return (
    <div
      role="status"
      aria-live="polite"
      style={{
        position: 'absolute',
        left: '50%',
        transform: 'translateX(-50%)',
        ...(position === 'top' ? { top: 70 } : { bottom: 24 }),
        padding: '10px 16px',
        borderRadius: radius.md,
        background: theme.toastBg,
        color: theme.toastFg,
        fontSize: fontSize.base,
        fontWeight: weight.medium,
        boxShadow: shadow.overlay,
        zIndex: 40,
        maxWidth: 'calc(100% - 32px)',
      }}
    >
      {message}
    </div>
  );
}

/** Wiwynn wordmark. The asset is served from each app's /public. */
export function Logo({ height = 22, src = '/assets/wiwynn-logo.png' }: { height?: number; src?: string }) {
  return <img src={src} alt="Wiwynn" style={{ height, width: 'auto' }} />;
}

/** Brand lockup: logo, divider, app name and a subtitle. */
export function AppMark({
  title,
  subtitle,
  logoHeight = 22,
}: {
  title: string;
  subtitle?: string;
  logoHeight?: number;
}) {
  const { theme } = useTheme();
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
      <Logo height={logoHeight} />
      {subtitle ? <div style={{ width: 1, height: 22, background: theme.border }} /> : null}
      <div style={{ display: 'flex', flexDirection: 'column', lineHeight: 1.2 }}>
        <span style={{ fontSize: fontSize.md, fontWeight: weight.semibold, color: theme.accent }}>
          {title}
        </span>
        {subtitle ? (
          <span style={{ fontSize: fontSize.xs, color: theme.fg3 }}>{subtitle}</span>
        ) : null}
      </div>
    </div>
  );
}
