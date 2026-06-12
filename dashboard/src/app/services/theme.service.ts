import { Injectable, signal, effect, inject } from '@angular/core';
import { SettingsService } from './settings.service';

export type Theme = 'dark' | 'light';

export interface ChartPalette {
  text: string;
  textMuted: string;
  grid: string;
  surface: string;
  accent: string;
  series: string[];
}

@Injectable({ providedIn: 'root' })
export class ThemeService {
  private readonly settings = inject(SettingsService);
  readonly theme = signal<Theme>(this.initial());

  constructor() {
    effect(() => {
      const t = this.theme();
      document.documentElement.setAttribute('data-theme', t);
      this.settings.set('theme', t);
    });
  }

  toggle(): void {
    this.theme.update((t) => (t === 'dark' ? 'light' : 'dark'));
  }

  /** Colors handed to Chart.js so charts follow the active theme. */
  palette(): ChartPalette {
    const dark = this.theme() === 'dark';
    return {
      text: dark ? '#e6edf3' : '#1f2733',
      textMuted: dark ? '#8b98a9' : '#5b6675',
      grid: dark ? 'rgba(255,255,255,0.07)' : 'rgba(15,23,42,0.08)',
      surface: dark ? '#161b22' : '#ffffff',
      accent: '#6366f1',
      series: [
        '#6366f1',
        '#22d3ee',
        '#34d399',
        '#fbbf24',
        '#f472b6',
        '#fb7185',
        '#a78bfa',
        '#38bdf8',
        '#4ade80',
        '#f59e0b',
      ],
    };
  }

  private initial(): Theme {
    const saved = this.settings.get<Theme>('theme', 'dark');
    return saved === 'light' || saved === 'dark' ? saved : 'dark';
  }
}
