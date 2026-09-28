/**
 * Design tokens — Wiwynn Design System, as used by the approved UI sample
 * ("Company Shuttle UI Sample.dc.html").
 *
 * This file is plain data with no React import, so the React Native driver app
 * can consume it through `@shuttle/ui/tokens` alongside the two web apps.
 *
 * Two rules carried over from the design doc and worth not breaking:
 *   1. Wiwynn Blue (#006090) carries structure — nav, primary actions, routes.
 *   2. Signal Green (#80d000) is reserved for "online / accepted / arrived".
 *      Using it for anything else destroys its meaning at a glance.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Brand palette
// ─────────────────────────────────────────────────────────────────────────────

export const brand = {
  /** Wiwynn Blue — primary structural colour. */
  blue: '#006090',
  /** Darker blue for headings and large numerals. */
  blueDeep: '#00344f',
  /** Mid blue for links and accent text on light surfaces. */
  blueText: '#00547e',
  /** Hover/pressed state of the primary button. */
  blueHover: '#00547e',
  /** Pale blue fill — selected nav items, active chips. */
  bluePale: '#e6eff5',
  /** Pale blue border to pair with bluePale. */
  bluePaleBorder: '#c2d8e5',
  /** Traveled route segment / secondary map stroke. */
  blueMuted: '#8fb5cd',
  /** Configured-but-inactive route stroke. */
  blueFaint: '#c2d8e5',
  /** Avatar chip fill. */
  avatarBg: '#c2d8e5',
  /** Avatar chip text. */
  avatarFg: '#004468',

  /** Signal Green — online / accepted / arrived ONLY. */
  green: '#80d000',
  greenDeep: '#3d6500',
  greenPale: '#f3fbe0',
  /** Darker green used for "healthy metric" text, where signal green is too loud. */
  greenText: '#1f9d55',
  greenTextDeep: '#156b3a',
  greenTextPale: '#e6f5ec',

  amber: '#d18700',
  amberText: '#8d5a00',
  amberPale: '#fbf1d9',

  info: '#0a6fbf',
  infoText: '#074d85',
  infoPale: '#e3f0fb',

  red: '#c4322a',
  redText: '#8b1f1a',
  redPale: '#fbe4e2',
} as const;

// ─────────────────────────────────────────────────────────────────────────────
// Semantic theme — light and dark (the guard tablet ships both)
// ─────────────────────────────────────────────────────────────────────────────

export interface Theme {
  /** App background, behind cards. */
  page: string;
  /** Card / panel background. */
  surface: string;
  /** Recessed fill — table headers, stepper buttons. */
  sunken: string;
  /** Hairline border. */
  border: string;
  /** Stronger border — inputs, outlined buttons. */
  borderStrong: string;
  /** Primary text. */
  fg: string;
  /** Secondary text. */
  fg2: string;
  /** Tertiary / label text. */
  fg3: string;
  /** Quaternary — disabled, watermarks. */
  fg4: string;
  /** Accent text (headings, brand wordmark). */
  accent: string;
  /** Primary button fill. */
  accentBtn: string;
  /** Selected-row background. */
  selected: string;
  /** Toast background / foreground. */
  toastBg: string;
  toastFg: string;
  /** Value for CSS `color-scheme`, so native date/time inputs match. */
  colorScheme: 'light' | 'dark';
}

export const lightTheme: Theme = {
  page: '#f7f9fb',
  surface: '#ffffff',
  sunken: '#f1f4f7',
  border: '#e6ebf0',
  borderStrong: '#d2dae2',
  fg: '#141a23',
  fg2: '#4d5965',
  fg3: '#677482',
  fg4: '#8a96a3',
  accent: '#00547e',
  accentBtn: '#006090',
  selected: '#f5f9fc',
  toastBg: '#00344f',
  toastFg: '#ffffff',
  colorScheme: 'light',
};

export const darkTheme: Theme = {
  page: '#0a0f16',
  surface: '#141a23',
  sunken: '#232c37',
  border: 'rgba(255,255,255,.10)',
  borderStrong: 'rgba(255,255,255,.18)',
  fg: '#f7f9fb',
  fg2: '#d2dae2',
  fg3: '#8a96a3',
  fg4: '#6b7887',
  accent: '#79bcdf',
  accentBtn: '#2f7aa1',
  selected: '#1a2430',
  toastBg: '#f7f9fb',
  toastFg: '#141a23',
  colorScheme: 'dark',
};

export type ThemeName = 'light' | 'dark';

export function themeFor(name: ThemeName): Theme {
  return name === 'dark' ? darkTheme : lightTheme;
}

// ─────────────────────────────────────────────────────────────────────────────
// Status pills
// ─────────────────────────────────────────────────────────────────────────────

export interface PillTone {
  bg: string;
  fg: string;
  dot: string;
}

/**
 * Pill tones by semantic intent. `ok` is the only one that uses Signal Green.
 */
export const tones = {
  ok: { bg: brand.greenPale, fg: brand.greenDeep, dot: brand.green },
  warn: { bg: brand.amberPale, fg: brand.amberText, dot: brand.amber },
  info: { bg: brand.infoPale, fg: brand.infoText, dot: brand.info },
  danger: { bg: brand.redPale, fg: brand.redText, dot: brand.red },
  neutral: { bg: '#f1f4f7', fg: '#38424e', dot: '#677482' },
  /** Muted green for operational "running" states, distinct from "accepted". */
  running: { bg: brand.greenTextPale, fg: brand.greenTextDeep, dot: brand.greenText },
} as const satisfies Record<string, PillTone>;

export type ToneName = keyof typeof tones;

/** Dark-mode pill tones — the light ones are unreadable on a dark surface. */
export const darkTones = {
  ok: { bg: '#1c2a12', fg: '#b3e23a', dot: brand.green },
  warn: { bg: '#3a2d0e', fg: '#f3c76b', dot: brand.amber },
  info: { bg: '#0f2a40', fg: '#8fc7ec', dot: '#4ea0cd' },
  danger: { bg: '#3a1512', fg: '#f0a19a', dot: brand.red },
  neutral: { bg: '#232c37', fg: '#d2dae2', dot: '#8a96a3' },
  running: { bg: '#122a1c', fg: '#7fd4a2', dot: brand.greenText },
} as const satisfies Record<ToneName, PillTone>;

export function toneFor(name: ToneName, theme: ThemeName = 'light'): PillTone {
  return theme === 'dark' ? darkTones[name] : tones[name];
}

/** Map a request status onto a pill tone. */
export function requestTone(status: string): ToneName {
  switch (status) {
    case 'pending':
      return 'warn';
    case 'accepted':
      return 'ok';
    case 'arrived':
      return 'ok';
    case 'boarding':
      return 'info';
    case 'completed':
      return 'neutral';
    case 'cancelled':
    case 'rejected':
      return 'danger';
    case 'expired':
      return 'neutral';
    default:
      return 'neutral';
  }
}

/** Map a shuttle's operational status onto a pill tone. */
export function shuttleTone(status: string): ToneName {
  switch (status) {
    case 'en_route':
      return 'running';
    case 'at_stop':
      return 'info';
    case 'full':
      return 'warn';
    case 'offline':
    case 'off_shift':
      return 'neutral';
    default:
      return 'neutral';
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Typography
// ─────────────────────────────────────────────────────────────────────────────

export const font = {
  sans: "'IBM Plex Sans', system-ui, -apple-system, 'Segoe UI', sans-serif",
  mono: "'IBM Plex Mono', ui-monospace, 'Cascadia Mono', monospace",
} as const;

/** Google Fonts href for the two families, at the weights the design uses. */
export const fontHref =
  'https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@400;500;600;700&family=IBM+Plex+Mono:wght@400;500;600&display=swap';

export const fontSize = {
  /** Label / caption. */
  xs: 11,
  sm: 12,
  base: 13,
  md: 14,
  lg: 15,
  xl: 18,
  /** Page title. */
  h2: 22,
  h1: 26,
  /** KPI numeral. */
  stat: 30,
  /** Hero ETA numeral. */
  hero: 44,
  heroLg: 56,
} as const;

export const weight = {
  regular: 400,
  medium: 500,
  semibold: 600,
  bold: 700,
} as const;

// ─────────────────────────────────────────────────────────────────────────────
// Space, radius, elevation
// ─────────────────────────────────────────────────────────────────────────────

export const space = {
  xs: 4,
  sm: 6,
  md: 8,
  lg: 10,
  xl: 12,
  '2xl': 14,
  '3xl': 16,
  '4xl': 20,
  '5xl': 24,
  '6xl': 32,
} as const;

export const radius = {
  sm: 4,
  md: 6,
  lg: 8,
  xl: 10,
  '2xl': 14,
  pill: 999,
} as const;

export const shadow = {
  /** Resting card. */
  card: '0 1px 0 rgba(20,26,35,.04), 0 4px 10px -2px rgba(20,26,35,.08)',
  /** Raised card — an incoming request that wants attention. */
  raised: '0 8px 24px -6px rgba(20,26,35,.14)',
  /** Bottom sheet, lifting upward. */
  sheet: '0 -8px 24px -6px rgba(20,26,35,.12)',
  /** Toast / popover. */
  overlay: '0 8px 24px -6px rgba(20,26,35,.3)',
  /** Side drawer. */
  drawer: '-12px 0 32px -16px rgba(20,26,35,.35)',
  /** Device bezel. */
  device: '0 24px 48px -16px rgba(20,26,35,.35)',
} as const;

/** Standard seat-bar length. Overridden per shuttle by its real capacity. */
export const DEFAULT_CAPACITY = 12;

/** Emit the theme as CSS custom properties for a stylesheet to pick up. */
export function themeCssVars(theme: Theme): Record<string, string> {
  return {
    '--page': theme.page,
    '--surface': theme.surface,
    '--sunken': theme.sunken,
    '--border': theme.border,
    '--border-strong': theme.borderStrong,
    '--fg': theme.fg,
    '--fg-2': theme.fg2,
    '--fg-3': theme.fg3,
    '--fg-4': theme.fg4,
    '--accent': theme.accent,
    '--accent-btn': theme.accentBtn,
    '--selected': theme.selected,
    '--toast-bg': theme.toastBg,
    '--toast-fg': theme.toastFg,
    '--font-sans': font.sans,
    '--font-mono': font.mono,
  };
}
