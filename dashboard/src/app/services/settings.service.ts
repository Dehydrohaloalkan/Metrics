import { Injectable } from '@angular/core';

interface MetricsApiSettings {
  isElectron?: boolean;
  loadSettings?: () => { ok?: boolean; data?: Record<string, unknown> } | Record<string, unknown>;
  saveSettings?: (data: Record<string, unknown>) => Promise<unknown>;
}

const LS_KEY = 'metrics-settings';

/**
 * Persistent app settings. In the packaged app they live in
 * `settings.json` inside the OS user-data folder (read synchronously at
 * startup, written on change). In a browser it falls back to localStorage.
 */
@Injectable({ providedIn: 'root' })
export class SettingsService {
  private cache: Record<string, unknown> = {};
  private readonly api = (window as unknown as { metricsAPI?: MetricsApiSettings }).metricsAPI;

  constructor() {
    this.cache = this.loadSync();
  }

  get<T>(key: string, fallback: T): T {
    return key in this.cache ? (this.cache[key] as T) : fallback;
  }

  set(key: string, value: unknown): void {
    this.cache[key] = value;
    this.persist();
  }

  private loadSync(): Record<string, unknown> {
    if (this.api?.isElectron && this.api.loadSettings) {
      try {
        const res = this.api.loadSettings() as { ok?: boolean; data?: Record<string, unknown> };
        // settings:get returns the object directly
        if (res && typeof res === 'object' && !('ok' in res)) return res as Record<string, unknown>;
        return res?.data ?? {};
      } catch {
        return {};
      }
    }
    try {
      return JSON.parse(localStorage.getItem(LS_KEY) || '{}');
    } catch {
      return {};
    }
  }

  private persist(): void {
    if (this.api?.isElectron && this.api.saveSettings) {
      this.api.saveSettings(this.cache);
      return;
    }
    try {
      localStorage.setItem(LS_KEY, JSON.stringify(this.cache));
    } catch {
      /* ignore */
    }
  }
}
