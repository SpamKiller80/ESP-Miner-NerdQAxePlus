import { Injectable } from '@angular/core';
import { HOME_CFG } from '../pages/home/home.cfg';

/**
 * Browser-local UI preferences (no firmware / NVS involved):
 *  - accent color (replaces the theme's primary color, e.g. the default purple)
 *  - display thresholds for the Input Current / Power bars on the dashboard
 *
 * Everything is stored in localStorage, so it is per browser. Nothing here can
 * change how the miner itself behaves: the firmware protections (shutdown temp,
 * power limits, ...) are untouched.
 */

export interface AccentPreset {
  id: string;
  /** Shown in the selector (not translated: color names are short and universal enough). */
  name: string;
  /** Base color (the "500" shade). `null` = keep the theme's own primary color. */
  base: string | null;
}

export const ACCENT_PRESETS: AccentPreset[] = [
  { id: 'theme',  name: 'Theme',  base: null },
  { id: 'blue',   name: 'Blau',   base: '#4c9aff' },
  { id: 'teal',   name: 'Türkis', base: '#1cc7b8' },
  { id: 'green',  name: 'Grün',   base: '#3ddc84' },
  { id: 'orange', name: 'Orange', base: '#ff9d3a' },
  { id: 'red',    name: 'Rot',    base: '#ff5c6c' },
  { id: 'pink',   name: 'Pink',   base: '#ff6bb5' },
];

export interface DisplayThresholds {
  /** Overrides the board's max input current (A). null = use the value reported by the device. */
  maxCurrentA: number | null;
  /** Overrides the board's max power (W). null = use the value reported by the device. */
  maxPowerW: number | null;
  /** Percent of max where the bar turns yellow. null = built-in default. */
  warnPct: number | null;
  /** Percent of max where the bar turns red. null = built-in default. */
  critPct: number | null;
}

export const EMPTY_THRESHOLDS: DisplayThresholds = {
  maxCurrentA: null,
  maxPowerW: null,
  warnPct: null,
  critPct: null,
};

const LS_ACCENT = 'ui.accent.v1';
const LS_THRESHOLDS = 'ui.thresholds.v1';

// Nebular (cosmic) alphas for the --color-primary-transparent-* variables.
const TRANSPARENT_ALPHAS: Record<number, number> = { 100: 0.08, 200: 0.16, 300: 0.24, 400: 0.32, 500: 0.4, 600: 0.48 };

// Original (purple-tinted) neutral palette of the "cosmic" theme. We keep lightness/saturation
// and only rotate the hue, so backgrounds, cards and borders follow the accent color too.
const COSMIC_BASIC: Record<number, string> = {
  100: '#ffffff', 200: '#f7f7fc', 300: '#f0f0fa', 400: '#e1e1f2', 500: '#ceceeb', 600: '#b4b4db',
  700: '#6a6a94', 800: '#323259', 900: '#252547', 1000: '#1b1b38', 1100: '#13132b',
};
const STYLE_ID = 'ui-accent-style';

/** Lightness offsets relative to the base (500) shade. 100..400 are lighter, 600..900 darker. */
const SHADE_L: Record<number, (baseL: number) => number> = {
  100: () => 98,
  200: () => 92,
  300: () => 82,
  400: (l) => Math.min(94, l + 9),
  500: (l) => l,
  600: (l) => l - 12,
  700: (l) => l - 24,
  800: (l) => l - 34,
  900: (l) => l - 42,
};

function hexToRgb(hex: string): { r: number; g: number; b: number } {
  const h = hex.replace('#', '');
  return {
    r: parseInt(h.slice(0, 2), 16),
    g: parseInt(h.slice(2, 4), 16),
    b: parseInt(h.slice(4, 6), 16),
  };
}

function rgbToHsl(r: number, g: number, b: number): { h: number; s: number; l: number } {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  let h = 0;
  let s = 0;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    switch (max) {
      case r: h = (g - b) / d + (g < b ? 6 : 0); break;
      case g: h = (b - r) / d + 2; break;
      default: h = (r - g) / d + 4;
    }
    h *= 60;
  }
  return { h, s: s * 100, l: l * 100 };
}

function hsl2rgb(h: number, s: number, l: number): { r: number; g: number; b: number } {
  s /= 100; l /= 100;
  const k = (n: number) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return { r: Math.round(f(0) * 255), g: Math.round(f(8) * 255), b: Math.round(f(4) * 255) };
}

function hsl(h: number, s: number, l: number): string {
  return `hsl(${Math.round(h)}, ${Math.round(s)}%, ${Math.round(Math.max(4, Math.min(99, l)))}%)`;
}

@Injectable({ providedIn: 'root' })
export class UiPrefsService {
  private accentId: string = 'theme';
  private thresholds: DisplayThresholds = { ...EMPTY_THRESHOLDS };
  private readonly baseHashrateColor: string = HOME_CFG.colors.hashrateBase;

  constructor() {
    this.accentId = this.readAccent();
    this.thresholds = this.readThresholds();
    // Apply as early as possible (service is instantiated by AppComponent).
    this.applyAccent();
  }

  // ---- accent -------------------------------------------------------------

  getAccentId(): string {
    return this.accentId;
  }

  /** Persist + apply. The dashboard chart picks the new color up when it is (re)created. */
  setAccent(id: string): void {
    const preset = ACCENT_PRESETS.find(p => p.id === id) ?? ACCENT_PRESETS[0];
    this.accentId = preset.id;
    this.safeSet(LS_ACCENT, preset.id);
    this.applyAccent();
  }

  private applyAccent(): void {
    const preset = ACCENT_PRESETS.find(p => p.id === this.accentId) ?? ACCENT_PRESETS[0];
    const style = document?.body?.style;
    if (!style) return;

    const shades = [100, 200, 300, 400, 500, 600, 700, 800, 900];

    this.applyBackground(preset.base);

    if (!preset.base) {
      for (const s of shades) style.removeProperty(`--color-primary-${s}`);
      for (const s of Object.keys(TRANSPARENT_ALPHAS)) style.removeProperty(`--color-primary-transparent-${s}`);
      (HOME_CFG.colors as any).hashrateBase = this.baseHashrateColor;
      return;
    }

    const { r, g, b } = hexToRgb(preset.base);
    const { h, s, l } = rgbToHsl(r, g, b);

    for (const shade of shades) {
      const value = shade === 500 ? preset.base : hsl(h, s, SHADE_L[shade](l));
      style.setProperty(`--color-primary-${shade}`, value);
    }
    for (const [shade, alpha] of Object.entries(TRANSPARENT_ALPHAS)) {
      style.setProperty(`--color-primary-transparent-${shade}`, `rgba(${r}, ${g}, ${b}, ${alpha})`);
    }

    // Chart line color (read once when the dashboard chart is built).
    (HOME_CFG.colors as any).hashrateBase = preset.base;
  }

  /** Rotate the hue of the cosmic theme's neutral palette (only active while the cosmic theme is selected). */
  private applyBackground(base: string | null): void {
    let el = document.getElementById(STYLE_ID) as HTMLStyleElement | null;
    if (!base) {
      el?.remove();
      return;
    }
    const { r, g, b } = hexToRgb(base);
    const targetHue = rgbToHsl(r, g, b).h;
    const rotate = (hex: string): { css: string; r: number; g: number; b: number } => {
      const c = hexToRgb(hex);
      const x = rgbToHsl(c.r, c.g, c.b);
      const out = hsl2rgb(targetHue, x.s, x.l);
      return { css: `rgb(${out.r}, ${out.g}, ${out.b})`, ...out };
    };
    const lines: string[] = [];
    for (const [shade, hex] of Object.entries(COSMIC_BASIC)) {
      lines.push(`--color-basic-${shade}: ${rotate(hex).css};`);
    }
    const mid = rotate(COSMIC_BASIC[600]);
    for (const [shade, alpha] of Object.entries(TRANSPARENT_ALPHAS)) {
      lines.push(`--color-basic-transparent-${shade}: rgba(${mid.r}, ${mid.g}, ${mid.b}, ${alpha});`);
    }
    const dark = rotate(COSMIC_BASIC[900]);
    lines.push(`--slide-out-background: ${dark.css};`);
    if (!el) {
      el = document.createElement('style');
      el.id = STYLE_ID;
      document.head.appendChild(el);
    }
    el.textContent = `body.nb-theme-cosmic { ${lines.join(' ')} }`;
  }

  // ---- thresholds ---------------------------------------------------------

  getThresholds(): DisplayThresholds {
    return { ...this.thresholds };
  }

  setThresholds(next: Partial<DisplayThresholds>): void {
    this.thresholds = this.sanitize({ ...this.thresholds, ...next });
    this.safeSet(LS_THRESHOLDS, JSON.stringify(this.thresholds));
  }

  resetThresholds(): void {
    this.thresholds = { ...EMPTY_THRESHOLDS };
    try { localStorage.removeItem(LS_THRESHOLDS); } catch { /* ignore */ }
  }

  /** Relative position (0..1) where a bar turns yellow, or `fallback` if not overridden. */
  warnRel(fallback: number): number {
    const w = this.thresholds.warnPct;
    return w == null ? fallback : w / 100;
  }

  /** Relative position (0..1) where a bar turns red, or `fallback` if not overridden. */
  critRel(fallback: number): number {
    const c = this.thresholds.critPct;
    return c == null ? fallback : c / 100;
  }

  /**
   * Replace the max values the dashboard bars are scaled to / measured against.
   * Mutates `info` (same style as normalizeHomeTileInfo).
   */
  applyToInfo(info: any): void {
    try {
      const t = this.thresholds;
      if (!info?.power) return;
      if (t.maxCurrentA != null) info.power.currentAMax = t.maxCurrentA;
      if (t.maxPowerW != null) info.power.max = t.maxPowerW;
    } catch { /* keep raw */ }
  }

  // ---- internals ----------------------------------------------------------

  private sanitize(t: DisplayThresholds): DisplayThresholds {
    const num = (v: any, lo: number, hi: number): number | null => {
      if (v === null || v === undefined || v === '') return null;
      const n = Number(v);
      if (!Number.isFinite(n)) return null;
      return Math.min(hi, Math.max(lo, n));
    };

    const out: DisplayThresholds = {
      maxCurrentA: num(t.maxCurrentA, 1, 100),
      maxPowerW: num(t.maxPowerW, 10, 2000),
      warnPct: num(t.warnPct, 50, 100),
      critPct: num(t.critPct, 50, 100),
    };

    // Red must not come before yellow.
    if (out.warnPct != null && out.critPct != null && out.critPct < out.warnPct) {
      out.critPct = out.warnPct;
    }
    return out;
  }

  private readAccent(): string {
    try {
      const id = localStorage.getItem(LS_ACCENT);
      if (id && ACCENT_PRESETS.some(p => p.id === id)) return id;
    } catch { /* ignore */ }
    return 'theme';
  }

  private readThresholds(): DisplayThresholds {
    try {
      const raw = localStorage.getItem(LS_THRESHOLDS);
      if (raw) return this.sanitize({ ...EMPTY_THRESHOLDS, ...JSON.parse(raw) });
    } catch { /* ignore */ }
    return { ...EMPTY_THRESHOLDS };
  }

  private safeSet(key: string, value: string): void {
    try { localStorage.setItem(key, value); } catch { /* ignore */ }
  }
}
