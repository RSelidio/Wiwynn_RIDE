/**
 * Driver-app theme.
 *
 * The colour values come from `@shuttle/ui/tokens`, so the driver tablet, the
 * employee PWA and the admin dashboard cannot drift apart. Only the numbers are
 * reused — the web components themselves are DOM-based and have no meaning in
 * React Native.
 *
 * Sizes here are larger than on the web throughout: this runs on a tablet
 * mounted in a vehicle and is operated with a thumb, often in motion.
 */

import { brand, lightTheme } from '@shuttle/ui/tokens';

export const colors = {
  page: lightTheme.page,
  surface: lightTheme.surface,
  sunken: lightTheme.sunken,
  border: lightTheme.border,
  borderStrong: lightTheme.borderStrong,
  fg: lightTheme.fg,
  fg2: lightTheme.fg2,
  fg3: lightTheme.fg3,

  accent: brand.blue,
  accentText: brand.blueText,
  accentDeep: brand.blueDeep,
  accentPale: brand.bluePale,

  /** Signal green — the accept action and "on shift" only. */
  go: brand.green,
  goText: brand.greenDeep,
  goPale: brand.greenPale,

  warn: brand.amber,
  warnText: brand.amberText,
  warnPale: brand.amberPale,

  info: brand.info,
  infoText: brand.infoText,
  infoPale: brand.infoPale,

  danger: brand.red,
  dangerText: brand.redText,
  dangerPale: brand.redPale,
} as const;

export const space = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 20,
  xxl: 28,
} as const;

export const radius = {
  sm: 6,
  md: 10,
  lg: 14,
  pill: 999,
} as const;

export const type = {
  label: 12,
  body: 15,
  title: 18,
  heading: 22,
  /** The big number a driver reads at a glance. */
  display: 34,
} as const;

/**
 * Minimum touch target.
 *
 * 56 rather than the usual 44: the driver is often wearing gloves and the
 * vehicle is moving, and a mis-tap here means a wrong trip state.
 */
export const TOUCH_TARGET = 56;
