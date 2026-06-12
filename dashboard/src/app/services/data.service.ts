import { Injectable, computed, inject, signal } from '@angular/core';
import Papa from 'papaparse';
import { LogRow, SourceInfo, ERROR_LEVELS, WARN_LEVELS } from '../models';
import { parseCsvStream } from '../csv-stream';
import { SettingsService } from './settings.service';

declare global {
  interface Window {
    metricsAPI?: {
      isElectron: boolean;
      loadDefault: () => Promise<{ ok: boolean; path?: string; content?: string; error?: string; canceled?: boolean }>;
      loadMembers: () => Promise<{ ok: boolean; path?: string; content?: string; error?: string; canceled?: boolean }>;
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

export interface HeatRow {
  day: number; // 0 = Mon .. 6 = Sun
  label: string;
  cells: number[];
  total: number;
}

export interface Heatmap {
  bucketMin: number;
  cols: number;
  colLabels: string[]; // hour number at hour boundaries, '' otherwise
  timeLabels: string[]; // HH:MM for every column
  rows: HeatRow[];
  min: number; // smallest non-zero cell (for contrast stretch)
  max: number;
  grandTotal: number;
}

/** A named group of source IPs, persisted between sessions. */
export interface SourceGroup {
  id: string;
  name: string;
  color: string;
  members: string[]; // source IPs belonging to the group
}

export interface GroupStat {
  id: string;
  name: string;
  color: string;
  count: number;
  errors: number;
  errorRate: number;
  share: number;
  sources: number;
  topEndpoint: string;
}

export interface FilterPreset {
  name: string;
  state: Record<string, unknown>;
}

const DAY_LABELS = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'];

/** Default palette handed to freshly created source groups. */
export const GROUP_COLORS = [
  '#6366f1', '#22d3ee', '#34d399', '#fbbf24', '#f472b6',
  '#fb7185', '#a78bfa', '#38bdf8', '#4ade80', '#f59e0b',
];

@Injectable({ providedIn: 'root' })
export class DataService {
  private readonly settings = inject(SettingsService);

  readonly rows = signal<LogRow[]>([]);
  readonly members = signal<Map<string, string>>(new Map()); // ip -> name
  readonly source = signal<SourceInfo | null>(null);
  readonly UNKNOWN = 'неизвестный пользователь';
  readonly UNGROUPED = '__ungrouped__';
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
  readonly dicStatuses = signal<Set<string>>(new Set());
  readonly groupFilter = signal<string>(''); // '' = all groups; or a group id / UNGROUPED
  readonly ipQuery = signal<string>('');
  readonly textQuery = signal<string>('');
  readonly onlyErrors = signal<boolean>(false);
  readonly granularity = signal<Granularity>('auto');

  // --- Persisted source groups & saved filter presets ----------------------
  readonly sourceGroups = signal<SourceGroup[]>(this.settings.get<SourceGroup[]>('sourceGroups', []));
  readonly presets = signal<FilterPreset[]>(this.settings.get<FilterPreset[]>('filterPresets', []));

  /** ip -> group id, for quick membership lookups. */
  readonly groupIndex = computed<Map<string, string>>(() => {
    const m = new Map<string, string>();
    for (const g of this.sourceGroups()) {
      for (const ip of g.members) if (!m.has(ip)) m.set(ip, g.id);
    }
    return m;
  });

  groupOf(ip: string): string {
    return this.groupIndex().get(ip) || this.UNGROUPED;
  }
  groupName(id: string): string {
    if (id === this.UNGROUPED) return 'Без группы';
    return this.sourceGroups().find((g) => g.id === id)?.name || id;
  }
  groupColor(id: string): string {
    if (id === this.UNGROUPED) return '#8b98a9';
    return this.sourceGroups().find((g) => g.id === id)?.color || '#6366f1';
  }

  saveGroups(groups: SourceGroup[]): void {
    this.sourceGroups.set(groups);
    this.settings.set('sourceGroups', groups);
    // a filtered-away group should not keep the dashboard empty
    if (this.groupFilter() && this.groupFilter() !== this.UNGROUPED &&
        !groups.some((g) => g.id === this.groupFilter())) {
      this.groupFilter.set('');
    }
  }

  // --- Distinct option lists (from full dataset) ----------------------------
  readonly allLevels = computed(() => this.distinct((r) => r.level));
  readonly allStatusClasses = computed(() => this.distinct((r) => r.statusClass).sort());
  readonly allServices = computed(() => this.distinct((r) => r.service).sort());
  readonly allEndpoints = computed(() => this.distinct((r) => r.nrDic).sort());
  readonly allDicStatuses = computed(() =>
    this.distinct((r) => r.dicStatus).filter((v) => v && v !== '—').sort(),
  );

  /** Every source IP seen in the dataset, with its all-time request count. */
  readonly allSources = computed<Counted[]>(() => {
    const map = new Map<string, number>();
    for (const r of this.rows()) {
      if (!r.ip || r.ip === '—') continue;
      map.set(r.ip, (map.get(r.ip) || 0) + 1);
    }
    return [...map.entries()]
      .map(([key, count]) => ({ key, count, errors: 0 }))
      .sort((a, b) => b.count - a.count);
  });

  readonly dataRange = computed<{ min: number; max: number } | null>(() => {
    const ts = this.rows()
      .map((r) => r.ts)
      .filter((t) => !isNaN(t));
    if (!ts.length) return null;
    return { min: Math.min(...ts), max: Math.max(...ts) };
  });

  // --- Filtered rows --------------------------------------------------------
  // Everything except the date window, so period-over-period can re-window the
  // same population, and the date filter stays cheap to re-apply.
  readonly nonDateFiltered = computed<LogRow[]>(() => {
    const lv = this.levels();
    const sc = this.statusClasses();
    const svc = this.service();
    const eps = this.endpoints();
    const dic = this.dicStatuses();
    const grp = this.groupFilter();
    const gi = grp ? this.groupIndex() : null;
    const ip = this.ipQuery().trim().toLowerCase();
    const text = this.textQuery().trim().toLowerCase();
    const onlyErr = this.onlyErrors();

    return this.rows().filter((r) => {
      if (lv.size && !lv.has(r.level)) return false;
      if (sc.size && !sc.has(r.statusClass)) return false;
      if (svc && r.service !== svc) return false;
      if (eps.size && !eps.has(r.nrDic)) return false;
      if (dic.size && !dic.has(r.dicStatus)) return false;
      if (grp) {
        const id = gi!.get(r.ip) || this.UNGROUPED;
        if (id !== grp) return false;
      }
      if (onlyErr && !r.isError) return false;
      if (ip) {
        const name = this.resolveName(r.ip).toLowerCase();
        if (!r.ip.toLowerCase().includes(ip) && !name.includes(ip)) return false;
      }
      if (text) {
        const hay = (r.message + ' ' + r.url + ' ' + r.exception + ' ' + r.logger + ' ' + r.nrDic).toLowerCase();
        if (!hay.includes(text)) return false;
      }
      return true;
    });
  });

  readonly filtered = computed<LogRow[]>(() => {
    const from = this.dateFrom();
    const to = this.dateTo();
    if (from == null && to == null) return this.nonDateFiltered();
    return this.nonDateFiltered().filter((r) => {
      if (from != null && (isNaN(r.ts) || r.ts < from)) return false;
      if (to != null && (isNaN(r.ts) || r.ts > to)) return false;
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
      this.dicStatuses().size > 0 ||
      this.groupFilter() !== '' ||
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

  // --- Period-over-period -------------------------------------------------
  // Compares the active window with the immediately preceding window of the
  // same length (same non-date filters). null when there is nothing to compare.
  readonly periodDeltas = computed<{
    totalPct: number;
    curErrRate: number;
    prevErrRate: number;
    errRatePts: number;
    hasPrev: boolean;
  } | null>(() => {
    const from = this.dateFrom();
    const to = this.dateTo();
    let a: number, b: number;
    if (from != null && to != null) {
      a = from;
      b = to;
    } else {
      const r = this.dataRange();
      if (!r) return null;
      a = r.min;
      b = r.max;
    }
    const len = b - a;
    if (len <= 0) return null;
    const prevA = a - len;

    let curT = 0, curE = 0, prevT = 0, prevE = 0;
    for (const r of this.nonDateFiltered()) {
      if (isNaN(r.ts)) continue;
      if (r.ts >= a && r.ts <= b) {
        curT++;
        if (r.isError) curE++;
      } else if (r.ts >= prevA && r.ts < a) {
        prevT++;
        if (r.isError) prevE++;
      }
    }
    const curErrRate = curT ? (curE / curT) * 100 : 0;
    const prevErrRate = prevT ? (prevE / prevT) * 100 : 0;
    return {
      totalPct: prevT ? ((curT - prevT) / prevT) * 100 : 0,
      curErrRate,
      prevErrRate,
      errRatePts: curErrRate - prevErrRate,
      hasPrev: prevT > 0,
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
  readonly byEndpoint = computed<Counted[]>(() => this.countBy((r) => r.nrDic));
  readonly topEndpoints = computed<Counted[]>(() => this.limited(this.countBy((r) => r.nrDic), this.endpointsLimit()));
  readonly topUrls = computed<Counted[]>(() => this.limited(this.countBy((r) => r.urlPath || r.url), this.urlsLimit()));
  readonly topIps = computed<Counted[]>(() => this.limited(this.countBy((r) => r.ip), this.ipsLimit()));
  readonly topExceptions = computed<Counted[]>(() =>
    this.countBy((r) => this.shortException(r.exception), (r) => !!r.exception).slice(0, 10),
  );
  readonly topHttpCodes = computed<Counted[]>(() =>
    this.countBy((r) => r.httpStatus, (r) => r.httpStatus !== '—'),
  );

  // --- Business status (cd_dic_status) -------------------------------------
  readonly byDicStatus = computed<Counted[]>(() =>
    this.countBy((r) => r.dicStatus, (r) => !!r.dicStatus && r.dicStatus !== '—'),
  );
  readonly topDicStatus = computed<Counted[]>(() => this.limited(this.byDicStatus(), 14));

  // --- Source groups: counts, comparison, per-group time series ------------
  readonly byGroup = computed<Counted[]>(() => {
    const gi = this.groupIndex();
    const map = new Map<string, Counted>();
    for (const r of this.filtered()) {
      const id = gi.get(r.ip) || this.UNGROUPED;
      let c = map.get(id);
      if (!c) {
        c = { key: id, count: 0, errors: 0 };
        map.set(id, c);
      }
      c.count++;
      if (r.isError) c.errors++;
    }
    return [...map.values()].sort((a, b) => b.count - a.count);
  });

  readonly groupStats = computed<GroupStat[]>(() => {
    const gi = this.groupIndex();
    const total = this.filtered().length;
    const agg = new Map<string, { count: number; errors: number; ips: Set<string>; ep: Map<string, number> }>();
    for (const r of this.filtered()) {
      const id = gi.get(r.ip) || this.UNGROUPED;
      let a = agg.get(id);
      if (!a) {
        a = { count: 0, errors: 0, ips: new Set(), ep: new Map() };
        agg.set(id, a);
      }
      a.count++;
      if (r.isError) a.errors++;
      if (r.ip && r.ip !== '—') a.ips.add(r.ip);
      if (r.nrDic && r.nrDic !== '—') a.ep.set(r.nrDic, (a.ep.get(r.nrDic) || 0) + 1);
    }
    return [...agg.entries()]
      .map(([id, a]) => {
        let topEndpoint = '—', mx = -1;
        for (const [k, v] of a.ep) if (v > mx) { mx = v; topEndpoint = k; }
        return {
          id,
          name: this.groupName(id),
          color: this.groupColor(id),
          count: a.count,
          errors: a.errors,
          errorRate: a.count ? (a.errors / a.count) * 100 : 0,
          share: total ? (a.count / total) * 100 : 0,
          sources: a.ips.size,
          topEndpoint,
        };
      })
      .sort((x, y) => y.count - x.count);
  });

  readonly groupTimeSeries = computed<{
    labels: string[];
    series: { id: string; name: string; color: string; data: number[]; total: number }[];
  }>(() => {
    const g = this.effectiveGranularity();
    const gi = this.groupIndex();
    const keys = new Set<number>();
    const perGroup = new Map<string, Map<number, number>>();
    for (const r of this.filtered()) {
      if (isNaN(r.ts)) continue;
      const id = gi.get(r.ip) || this.UNGROUPED;
      const bk = this.bucketKey(r.date!, g);
      keys.add(bk);
      let m = perGroup.get(id);
      if (!m) {
        m = new Map();
        perGroup.set(id, m);
      }
      m.set(bk, (m.get(bk) || 0) + 1);
    }
    const sorted = [...keys].sort((a, b) => a - b);
    const labels = sorted.map((k) => this.bucketLabel(k, g));
    const series = [...perGroup.entries()]
      .map(([id, m]) => ({
        id,
        name: this.groupName(id),
        color: this.groupColor(id),
        data: sorted.map((k) => m.get(k) || 0),
        total: [...m.values()].reduce((a, b) => a + b, 0),
      }))
      .sort((a, b) => b.total - a.total);
    return { labels, series };
  });

  // --- Pareto (source concentration) ---------------------------------------
  readonly sourcePareto = computed<{ points: { key: string; count: number; cumPct: number }[]; total: number }>(() => {
    const src = this.bySource().filter((s) => s.key !== '—');
    const total = src.reduce((s, i) => s + i.count, 0);
    let cum = 0;
    const points = src.slice(0, 20).map((s) => {
      cum += s.count;
      return { key: this.sourceLabel(s.key), count: s.count, cumPct: total ? (cum / total) * 100 : 0 };
    });
    return { points, total };
  });

  // --- Status-class composition over time (stacked area) -------------------
  readonly statusTrend = computed<{ labels: string[]; series: { key: string; data: number[] }[] }>(() => {
    const g = this.effectiveGranularity();
    const classes = ['2xx', '3xx', '4xx', '5xx', '1xx', '—'];
    const keys = new Set<number>();
    const per = new Map<string, Map<number, number>>();
    for (const c of classes) per.set(c, new Map());
    for (const r of this.filtered()) {
      if (isNaN(r.ts)) continue;
      const bk = this.bucketKey(r.date!, g);
      keys.add(bk);
      const m = per.get(r.statusClass) ?? per.get('—')!;
      m.set(bk, (m.get(bk) || 0) + 1);
    }
    const sorted = [...keys].sort((a, b) => a - b);
    const labels = sorted.map((k) => this.bucketLabel(k, g));
    const series = classes
      .map((key) => ({ key, data: sorted.map((k) => per.get(key)!.get(k) || 0) }))
      .filter((s) => s.data.some((v) => v > 0));
    return { labels, series };
  });

  // --- Source ↔ endpoint relationship graph (force-directed cloud) ---------
  readonly graph = computed<{
    nodes: { id: string; label: string; kind: 'source' | 'endpoint'; count: number; color: string }[];
    links: { source: string; target: string; value: number }[];
  }>(() => {
    const gi = this.groupIndex();
    const SEP = String.fromCharCode(1);
    const srcCount = new Map<string, number>();
    const epCount = new Map<string, number>();
    const linkMap = new Map<string, number>();
    for (const r of this.filtered()) {
      const ip = r.ip || '—';
      const ep = r.nrDic || '—';
      if (ip === '—' && ep === '—') continue;
      srcCount.set(ip, (srcCount.get(ip) || 0) + 1);
      epCount.set(ep, (epCount.get(ep) || 0) + 1);
      const lk = ip + SEP + ep;
      linkMap.set(lk, (linkMap.get(lk) || 0) + 1);
    }
    const topSrc = [...srcCount.entries()].sort((a, b) => b[1] - a[1]).slice(0, 18);
    const topEp = [...epCount.entries()].sort((a, b) => b[1] - a[1]).slice(0, 14);
    const srcSet = new Set(topSrc.map((s) => s[0]));
    const epSet = new Set(topEp.map((e) => e[0]));
    const nodes = [
      ...topSrc.map(([id, count]) => ({
        id: 's' + id,
        label: this.sourceLabel(id),
        kind: 'source' as const,
        count,
        color: this.groupColor(gi.get(id) || this.UNGROUPED),
      })),
      ...topEp.map(([id, count]) => ({
        id: 'e' + id,
        label: id,
        kind: 'endpoint' as const,
        count,
        color: '#22d3ee',
      })),
    ];
    const links: { source: string; target: string; value: number }[] = [];
    for (const [lk, value] of linkMap) {
      const i = lk.indexOf(SEP);
      const ip = lk.slice(0, i);
      const ep = lk.slice(i + 1);
      if (srcSet.has(ip) && epSet.has(ep)) {
        links.push({ source: 's' + ip, target: 'e' + ep, value });
      }
    }
    return { nodes, links };
  });

  // --- Sources (IP + member name) ------------------------------------------
  readonly selectedSource = signal<string>(''); // '' = auto (top source)

  /** All sources sorted by request count (key = ip). */
  readonly bySource = computed<Counted[]>(() => this.countBy((r) => r.ip));

  /** The ip currently drilled into (selected or the busiest one). */
  readonly activeSource = computed<string>(() => {
    const sel = this.selectedSource();
    if (sel) return sel;
    return this.bySource()[0]?.key ?? '';
  });

  /** Endpoint breakdown for the active source. */
  readonly sourceEndpoints = computed<Counted[]>(() => {
    const ip = this.activeSource();
    if (!ip) return [];
    return this.countBy((r) => r.nrDic, (r) => r.ip === ip);
  });

  // --- Weekday × time-of-day heatmap (overlay all days by weekday) ---------
  readonly heatmapBucketMin = signal(60); // minutes per column

  readonly heatmap = computed<Heatmap>(() => {
    const bm = this.heatmapBucketMin();
    const cols = Math.ceil(1440 / bm);
    const grid: number[][] = Array.from({ length: 7 }, () => new Array(cols).fill(0));
    let max = 0;
    let grandTotal = 0;

    for (const r of this.filtered()) {
      if (isNaN(r.ts)) continue;
      const d = r.date!;
      const day = (d.getDay() + 6) % 7; // Monday = 0
      const idx = Math.floor((d.getHours() * 60 + d.getMinutes()) / bm);
      const v = ++grid[day][idx];
      if (v > max) max = v;
      grandTotal++;
    }

    const colLabels: string[] = [];
    const timeLabels: string[] = [];
    const pad = (x: number) => String(x).padStart(2, '0');
    for (let c = 0; c < cols; c++) {
      const m = c * bm;
      colLabels.push(m % 60 === 0 ? String(m / 60) : '');
      timeLabels.push(`${pad(Math.floor(m / 60))}:${pad(m % 60)}`);
    }

    let min = Infinity;
    for (const r of grid) for (const v of r) if (v > 0 && v < min) min = v;
    if (min === Infinity) min = 0;

    const rows: HeatRow[] = grid.map((cells, day) => ({
      day,
      label: DAY_LABELS[day],
      cells,
      total: cells.reduce((a, b) => a + b, 0),
    }));

    return { bucketMin: bm, cols, colLabels, timeLabels, rows, min, max, grandTotal };
  });

  // --- Auto-insights -------------------------------------------------------
  readonly insights = computed<{ icon: string; tone: 'good' | 'warn' | 'bad' | 'info'; text: string }[]>(() => {
    const rows = this.filtered();
    const out: { icon: string; tone: 'good' | 'warn' | 'bad' | 'info'; text: string }[] = [];
    if (!rows.length) return out;
    const k = this.kpis();
    const f = (n: number) => Math.round(n).toLocaleString('ru-RU');

    if (k.total) {
      if (k.errorRate < 1)
        out.push({ icon: '✅', tone: 'good', text: `Сервис стабилен: ошибок ${k.errorRate.toFixed(2)}% (${f(k.errors)} из ${f(k.total)})` });
      else if (k.errorRate > 5)
        out.push({ icon: '🔥', tone: 'bad', text: `Высокая доля ошибок: ${k.errorRate.toFixed(1)}% (${f(k.errors)})` });
      else out.push({ icon: 'ℹ️', tone: 'info', text: `Доля ошибок ${k.errorRate.toFixed(1)}% (${f(k.errors)})` });
    }

    const hm = this.heatmap();
    if (hm.max > 0) {
      let bd = 0, bc = 0, bv = -1;
      hm.rows.forEach((r) => r.cells.forEach((v, c) => { if (v > bv) { bv = v; bd = r.day; bc = c; } }));
      out.push({ icon: '⏰', tone: 'info', text: `Пик нагрузки: ${DAY_LABELS[bd]} ~${hm.timeLabels[bc]} (${f(bv)} запр.)` });
    }

    const src = this.bySource();
    if (src.length && src[0].key !== '—') {
      const top = src[0];
      const share = k.total ? (top.count / k.total) * 100 : 0;
      out.push({ icon: '👤', tone: 'info', text: `Активнее всех: ${this.sourceLabel(top.key)} — ${share.toFixed(0)}% (${f(top.count)})` });
    }

    const errIp = new Map<string, number>();
    const errEp = new Map<string, number>();
    for (const r of rows) {
      if (!r.isError) continue;
      errIp.set(r.ip, (errIp.get(r.ip) || 0) + 1);
      errEp.set(r.nrDic, (errEp.get(r.nrDic) || 0) + 1);
    }
    if (errIp.size) {
      const [ip, cnt] = [...errIp.entries()].sort((a, b) => b[1] - a[1])[0];
      out.push({ icon: '🐞', tone: 'warn', text: `Больше всего ошибок от ${this.sourceLabel(ip)} — ${f(cnt)}` });
    }
    if (errEp.size) {
      const [ep, cnt] = [...errEp.entries()].sort((a, b) => b[1] - a[1])[0];
      if (ep !== '—') out.push({ icon: '🎯', tone: 'warn', text: `Чаще всего ошибается эндпоинт ${ep} — ${f(cnt)}` });
    }

    const ts = this.timeSeries();
    if (ts.length >= 4) {
      const totals = ts.map((b) => b.total);
      const mean = totals.reduce((a, b) => a + b, 0) / totals.length;
      const sd = Math.sqrt(totals.reduce((a, b) => a + (b - mean) ** 2, 0) / totals.length);
      let mi = -1, mv = -1;
      totals.forEach((v, i) => { if (v > mv) { mv = v; mi = i; } });
      if (sd > 0 && mv > mean + 3 * sd)
        out.push({ icon: '📈', tone: 'warn', text: `Всплеск ${ts[mi].label}: ${f(mv)} (≈×${(mv / mean).toFixed(1)} от среднего)` });
    }

    return out;
  });

  resolveName(ip: string): string {
    return this.members().get(ip) || '';
  }

  /** Human label for a source ip: member name, or "неизвестный · ip". */
  sourceLabel(ip: string): string {
    const name = this.resolveName(ip);
    return name ? name : `${this.UNKNOWN} · ${ip}`;
  }

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

  async loadMembers(): Promise<void> {
    try {
      let text: string | null = null;
      if (window.metricsAPI?.isElectron) {
        const res = await window.metricsAPI.loadMembers();
        if (res.ok && res.content != null) text = res.content;
      } else {
        const resp = await fetch('members.csv');
        if (resp.ok) text = await resp.text();
      }
      if (text != null) this.members.set(this.parseMembers(text));
    } catch {
      /* members are optional — ignore failures */
    }
  }

  /** members.csv: `"ip", "name"` (quotes and spaces tolerated). */
  private parseMembers(text: string): Map<string, string> {
    const map = new Map<string, string>();
    const lines = text.split(/\r?\n/);
    for (const line of lines) {
      if (!line.trim()) continue;
      const cols = line.split(',').map((c) => c.trim().replace(/^"|"$/g, '').trim());
      const ip = cols[0];
      const name = cols[1] ?? '';
      if (!ip || ip.toLowerCase() === 'ip') continue; // skip header
      if (name) map.set(ip, name);
    }
    return map;
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
    this.dicStatuses.set(new Set());
    this.groupFilter.set('');
    this.ipQuery.set('');
    this.textQuery.set('');
    this.onlyErrors.set(false);
    this.selectedSource.set('');
  }

  // --- Saved filter presets -------------------------------------------------
  private captureState(): Record<string, unknown> {
    return {
      dateFrom: this.dateFrom(),
      dateTo: this.dateTo(),
      levels: [...this.levels()],
      statusClasses: [...this.statusClasses()],
      service: this.service(),
      endpoints: [...this.endpoints()],
      dicStatuses: [...this.dicStatuses()],
      groupFilter: this.groupFilter(),
      ipQuery: this.ipQuery(),
      textQuery: this.textQuery(),
      onlyErrors: this.onlyErrors(),
    };
  }

  savePreset(name: string): void {
    const trimmed = name.trim();
    if (!trimmed) return;
    const next = [...this.presets().filter((p) => p.name !== trimmed), { name: trimmed, state: this.captureState() }];
    this.presets.set(next);
    this.settings.set('filterPresets', next);
  }

  applyPreset(name: string): void {
    const p = this.presets().find((x) => x.name === name);
    if (!p) return;
    const s = p.state as Record<string, unknown>;
    const arr = (v: unknown) => (Array.isArray(v) ? (v as string[]) : []);
    this.dateFrom.set((s['dateFrom'] as number | null) ?? null);
    this.dateTo.set((s['dateTo'] as number | null) ?? null);
    this.levels.set(new Set(arr(s['levels'])));
    this.statusClasses.set(new Set(arr(s['statusClasses'])));
    this.service.set((s['service'] as string) ?? '');
    this.endpoints.set(new Set(arr(s['endpoints'])));
    this.dicStatuses.set(new Set(arr(s['dicStatuses'])));
    this.groupFilter.set((s['groupFilter'] as string) ?? '');
    this.ipQuery.set((s['ipQuery'] as string) ?? '');
    this.textQuery.set((s['textQuery'] as string) ?? '');
    this.onlyErrors.set(!!s['onlyErrors']);
  }

  deletePreset(name: string): void {
    const next = this.presets().filter((p) => p.name !== name);
    this.presets.set(next);
    this.settings.set('filterPresets', next);
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
        requester_name: this.resolveName(r.ip) || this.UNKNOWN,
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
