import { Injectable, computed, signal } from '@angular/core';
import Papa from 'papaparse';
import { LogRow, SourceInfo, ERROR_LEVELS, WARN_LEVELS } from '../models';
import { parseCsvStream } from '../csv-stream';

declare global {
  interface Window {
    metricsAPI?: {
      isElectron: boolean;
      loadDefault: () => Promise<{ ok: boolean; path?: string; content?: string; error?: string; canceled?: boolean }>;
      pickFile: () => Promise<{ ok: boolean; path?: string; content?: string; error?: string; canceled?: boolean }>;
    };
  }
}

export type Granularity = 'auto' | 'second' | 'minute' | 'hour' | 'day' | 'week' | 'month';
export type EffectiveGranularity = Exclude<Granularity, 'auto'>;

export interface Bucket {
  label: string;
  total: number;
  errors: number;
}

export interface Counted {
  key: string;
  count: number;
  errors: number;
}

@Injectable({ providedIn: 'root' })
export class DataService {
  readonly rows = signal<LogRow[]>([]);
  readonly source = signal<SourceInfo | null>(null);
  readonly loading = signal(false);
  readonly progress = signal<{ phase: string; pct: number } | null>(null);
  readonly status = signal<string>('');
  readonly isElectron = !!window.metricsAPI?.isElectron;

  // how many bars to show in the "top N" charts (0 = all)
  readonly endpointsLimit = signal(15);
  readonly ipsLimit = signal(15);
  readonly urlsLimit = signal(15);

  // --- Filter state ---------------------------------------------------------
  readonly dateFrom = signal<number | null>(null);
  readonly dateTo = signal<number | null>(null);
  readonly levels = signal<Set<string>>(new Set()); // empty = all
  readonly statusClasses = signal<Set<string>>(new Set());
  readonly service = signal<string>(''); // '' = all
  readonly endpoints = signal<Set<string>>(new Set());
  readonly ipQuery = signal<string>('');
  readonly textQuery = signal<string>('');
  readonly onlyErrors = signal<boolean>(false);
  readonly granularity = signal<Granularity>('auto');

  // --- Distinct option lists (from full dataset) ----------------------------
  readonly allLevels = computed(() => this.distinct((r) => r.level));
  readonly allStatusClasses = computed(() => this.distinct((r) => r.statusClass).sort());
  readonly allServices = computed(() => this.distinct((r) => r.service).sort());
  readonly allEndpoints = computed(() => this.distinct((r) => r.nrDic).sort());

  readonly dataRange = computed<{ min: number; max: number } | null>(() => {
    const ts = this.rows()
      .map((r) => r.ts)
      .filter((t) => !isNaN(t));
    if (!ts.length) return null;
    return { min: Math.min(...ts), max: Math.max(...ts) };
  });

  // --- Filtered rows --------------------------------------------------------
  readonly filtered = computed<LogRow[]>(() => {
    const from = this.dateFrom();
    const to = this.dateTo();
    const lv = this.levels();
    const sc = this.statusClasses();
    const svc = this.service();
    const eps = this.endpoints();
    const ip = this.ipQuery().trim().toLowerCase();
    const text = this.textQuery().trim().toLowerCase();
    const onlyErr = this.onlyErrors();

    return this.rows().filter((r) => {
      if (from != null && (isNaN(r.ts) || r.ts < from)) return false;
      if (to != null && (isNaN(r.ts) || r.ts > to)) return false;
      if (lv.size && !lv.has(r.level)) return false;
      if (sc.size && !sc.has(r.statusClass)) return false;
      if (svc && r.service !== svc) return false;
      if (eps.size && !eps.has(r.nrDic)) return false;
      if (onlyErr && !r.isError) return false;
      if (ip && !r.ip.toLowerCase().includes(ip)) return false;
      if (text) {
        const hay = (r.message + ' ' + r.url + ' ' + r.exception + ' ' + r.logger + ' ' + r.nrDic).toLowerCase();
        if (!hay.includes(text)) return false;
      }
      return true;
    });
  });

  readonly hasActiveFilters = computed(
    () =>
      this.dateFrom() != null ||
      this.dateTo() != null ||
      this.levels().size > 0 ||
      this.statusClasses().size > 0 ||
      this.service() !== '' ||
      this.endpoints().size > 0 ||
      this.ipQuery().trim() !== '' ||
      this.textQuery().trim() !== '' ||
      this.onlyErrors(),
  );

  // --- KPIs -----------------------------------------------------------------
  readonly kpis = computed(() => {
    const rows = this.filtered();
    const total = rows.length;
    let errors = 0;
    let warnings = 0;
    let ok2xx = 0;
    let withCode = 0;
    const ips = new Set<string>();
    const eps = new Set<string>();
    let min = Infinity;
    let max = -Infinity;

    for (const r of rows) {
      if (r.isError) errors++;
      if (WARN_LEVELS.has(r.levelNorm)) warnings++;
      if (!isNaN(r.httpCode) && r.httpCode > 0) {
        withCode++;
        if (r.statusClass === '2xx') ok2xx++;
      }
      if (r.ip && r.ip !== '—') ips.add(r.ip);
      if (r.nrDic && r.nrDic !== '—') eps.add(r.nrDic);
      if (!isNaN(r.ts)) {
        if (r.ts < min) min = r.ts;
        if (r.ts > max) max = r.ts;
      }
    }

    const spanMs = max >= min ? max - min : 0;
    const spanHours = spanMs / 36e5;
    const perHour = spanHours > 0 ? total / spanHours : 0;

    return {
      total,
      errors,
      warnings,
      errorRate: total ? (errors / total) * 100 : 0,
      successRate: withCode ? (ok2xx / withCode) * 100 : 0,
      uniqueIps: ips.size,
      uniqueEndpoints: eps.size,
      perHour,
      from: min === Infinity ? null : min,
      to: max === -Infinity ? null : max,
    };
  });

  // --- Aggregations for charts ---------------------------------------------
  readonly effectiveGranularity = computed<EffectiveGranularity>(() => {
    const g = this.granularity();
    if (g !== 'auto') return g;
    const k = this.kpis();
    if (k.from == null || k.to == null) return 'day';
    const ms = k.to - k.from;
    const min = 60e3;
    if (ms <= 2 * min) return 'second';
    if (ms <= 180 * min) return 'minute';
    if (ms <= 3 * 864e5) return 'hour';
    if (ms <= 120 * 864e5) return 'day';
    if (ms <= 730 * 864e5) return 'week';
    return 'month';
  });

  readonly timeSeries = computed<Bucket[]>(() => {
    const g = this.effectiveGranularity();
    const map = new Map<number, Bucket>();
    for (const r of this.filtered()) {
      if (isNaN(r.ts)) continue;
      const key = this.bucketKey(r.date!, g);
      let b = map.get(key);
      if (!b) {
        b = { label: this.bucketLabel(key, g), total: 0, errors: 0 };
        map.set(key, b);
      }
      b.total++;
      if (r.isError) b.errors++;
    }
    return [...map.entries()].sort((a, b) => a[0] - b[0]).map(([, b]) => b);
  });

  readonly byLevel = computed<Counted[]>(() => this.countBy((r) => r.level));
  readonly byStatusClass = computed<Counted[]>(() =>
    this.countBy((r) => r.statusClass).sort((a, b) => a.key.localeCompare(b.key)),
  );
  readonly byService = computed<Counted[]>(() => this.countBy((r) => r.service));
  readonly topEndpoints = computed<Counted[]>(() => this.limited(this.countBy((r) => r.nrDic), this.endpointsLimit()));
  readonly topUrls = computed<Counted[]>(() => this.limited(this.countBy((r) => r.urlPath || r.url), this.urlsLimit()));
  readonly topIps = computed<Counted[]>(() => this.limited(this.countBy((r) => r.ip), this.ipsLimit()));
  readonly topExceptions = computed<Counted[]>(() =>
    this.countBy((r) => this.shortException(r.exception), (r) => !!r.exception).slice(0, 10),
  );
  readonly topHttpCodes = computed<Counted[]>(() =>
    this.countBy((r) => r.httpStatus, (r) => r.httpStatus !== '—'),
  );

  // --- Loading --------------------------------------------------------------
  async loadDefault(): Promise<void> {
    if (window.metricsAPI?.isElectron) {
      this.loading.set(true);
      try {
        const res = await window.metricsAPI.loadDefault();
        if (res.ok && res.content != null) {
          await this.ingest(res.content, this.baseName(res.path) || 'data.csv', res.path || '');
        } else {
          this.status.set(res.error || 'Не удалось найти data.csv рядом с приложением.');
        }
      } finally {
        this.loading.set(false);
      }
      return;
    }

    // Browser dev: fetch from served assets
    this.loading.set(true);
    try {
      const resp = await fetch('data.csv');
      if (!resp.ok) throw new Error('HTTP ' + resp.status);
      const text = await resp.text();
      await this.ingest(text, 'data.csv', 'public/data.csv');
    } catch (e) {
      this.status.set('Не удалось загрузить data.csv: ' + String(e));
    } finally {
      this.loading.set(false);
    }
  }

  async pickFile(): Promise<void> {
    if (!window.metricsAPI?.isElectron) {
      this.status.set('Выбор файла доступен только в собранном приложении.');
      return;
    }
    this.loading.set(true);
    try {
      const res = await window.metricsAPI.pickFile();
      if (res.canceled) return;
      if (res.ok && res.content != null) {
        await this.ingest(res.content, this.baseName(res.path) || 'csv', res.path || '');
      } else {
        this.status.set(res.error || 'Не удалось прочитать файл.');
      }
    } finally {
      this.loading.set(false);
    }
  }

  async ingestText(text: string, name: string): Promise<void> {
    await this.ingest(text, name, name);
  }

  private async ingest(text: string, name: string, path: string): Promise<void> {
    this.loading.set(true);
    this.progress.set({ phase: 'Разбор CSV…', pct: 0 });
    // Let the loading overlay paint before the heavy work starts.
    await new Promise((r) => setTimeout(r));
    try {
      const rows = await parseCsvStream(text, (pct, count) => {
        this.progress.set({ phase: `Разбор строк: ${count.toLocaleString('ru-RU')}`, pct });
      });
      this.progress.set({ phase: 'Готово', pct: 1 });
      this.rows.set(rows);
      this.source.set({ name, path, rows: rows.length });
      this.status.set(rows.length ? '' : 'Файл загружен, но строк не найдено.');
      this.resetFilters();
    } finally {
      this.loading.set(false);
      this.progress.set(null);
    }
  }

  resetFilters(): void {
    this.dateFrom.set(null);
    this.dateTo.set(null);
    this.levels.set(new Set());
    this.statusClasses.set(new Set());
    this.service.set('');
    this.endpoints.set(new Set());
    this.ipQuery.set('');
    this.textQuery.set('');
    this.onlyErrors.set(false);
  }

  toggleSet(sig: ReturnType<typeof signal<Set<string>>>, value: string): void {
    const next = new Set(sig());
    if (next.has(value)) next.delete(value);
    else next.add(value);
    sig.set(next);
  }

  exportFilteredCsv(): string {
    const rows = this.filtered();
    return Papa.unparse(
      rows.map((r) => ({
        id_service_log: r.id,
        cd_service: r.service,
        dt_tm_event: r.dateRaw,
        level: r.level,
        logger: r.logger,
        message: r.message,
        ip_requester: r.ip,
        exception: r.exception,
        url: r.url,
        nr_dic: r.nrDic,
        cd_dic_status: r.dicStatus,
        cd_http_status: r.httpStatus,
      })),
    );
  }

  // --- helpers --------------------------------------------------------------
  private distinct(sel: (r: LogRow) => string): string[] {
    const s = new Set<string>();
    for (const r of this.rows()) {
      const v = sel(r);
      if (v) s.add(v);
    }
    return [...s];
  }

  private countBy(
    sel: (r: LogRow) => string,
    keep: (r: LogRow) => boolean = () => true,
  ): Counted[] {
    const map = new Map<string, Counted>();
    for (const r of this.filtered()) {
      if (!keep(r)) continue;
      const key = sel(r) || '—';
      let c = map.get(key);
      if (!c) {
        c = { key, count: 0, errors: 0 };
        map.set(key, c);
      }
      c.count++;
      if (r.isError) c.errors++;
    }
    return [...map.values()].sort((a, b) => b.count - a.count);
  }

  private limited<T>(arr: T[], limit: number): T[] {
    return limit > 0 ? arr.slice(0, limit) : arr;
  }

  private bucketKey(d: Date, g: EffectiveGranularity): number {
    const x = new Date(d);
    if (g === 'second') {
      x.setMilliseconds(0);
      return x.getTime();
    }
    x.setSeconds(0, 0);
    if (g === 'minute') return x.getTime();
    x.setMinutes(0);
    if (g === 'hour') return x.getTime();
    x.setHours(0);
    if (g === 'day') return x.getTime();
    if (g === 'week') {
      const dow = (x.getDay() + 6) % 7; // Monday = 0
      x.setDate(x.getDate() - dow);
      return x.getTime();
    }
    x.setDate(1);
    return x.getTime();
  }

  private bucketLabel(key: number, g: EffectiveGranularity): string {
    const d = new Date(key);
    const p = (n: number) => String(n).padStart(2, '0');
    const dm = `${p(d.getDate())}.${p(d.getMonth() + 1)}`;
    switch (g) {
      case 'second':
        return `${dm} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
      case 'minute':
        return `${dm} ${p(d.getHours())}:${p(d.getMinutes())}`;
      case 'hour':
        return `${dm} ${p(d.getHours())}:00`;
      case 'day':
        return `${dm}.${d.getFullYear()}`;
      case 'week':
        return `нед ${dm}`;
      default:
        return `${p(d.getMonth() + 1)}.${d.getFullYear()}`;
    }
  }

  private shortException(ex: string): string {
    if (!ex) return '';
    const firstLine = ex.split('\n')[0].trim();
    return firstLine.length > 80 ? firstLine.slice(0, 80) + '…' : firstLine;
  }

  private baseName(p?: string): string {
    if (!p) return '';
    return p.split(/[\\/]/).pop() || p;
  }
}
