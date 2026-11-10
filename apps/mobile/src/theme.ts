/** Design tokens shared by every screen. Fonts: Bricolage Grotesque for headings, Instrument Sans for body. */
export const colors = {
  ink: '#1b1b18',
  inkSoft: '#55554d',
  paper: '#faf7f0',
  line: '#ddd6c6',
  accent: '#a83a0b',
  onAccent: '#ffffff',
  disabled: '#8d8a80',
} as const;

export const fonts = {
  heading: 'BricolageGrotesque_700Bold',
  body: 'InstrumentSans_400Regular',
  bodyBold: 'InstrumentSans_600SemiBold',
} as const;

export const space = { s: 8, m: 16, l: 24 } as const;

/** Minimum touch target for Android (dp). */
export const TOUCH = 48;
