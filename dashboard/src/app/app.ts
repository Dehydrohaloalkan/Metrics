import {
  Component,
  computed,
  signal,
  inject,
  OnInit,
  HostListener,
  ChangeDetectionStrategy,
} from '@angular/core';
import { NgTemplateOutlet } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ChartConfiguration } from 'chart.js';
import { DataService, Granularity } from './services/data.service';
import { ThemeService } from './services/theme.service';
import { SettingsService } from './services/settings.service';
import { ChartPanelComponent } from './components/chart-panel.component';
import { HeatmapComponent } from './components/heatmap.component';
import { CountComponent } from './components/count.component';
import { SparklineComponent } from './components/sparkline.component';
import { LogRow } from './models';

type SortKey = 'date' | 'level' | 'service' | 'nrDic' | 'httpCode' | 'ip';
type CrossKind = 'level' | 'status' | 'endpoint' | 'service' | 'ip' | 'text';

@Component({
  selector: 'app-root',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    FormsModule,
    NgTemplateOutlet,
    ChartPanelComponent,
    HeatmapComponent,
    CountComponent,
    SparklineComponent,
  ],
  templateUrl: './app.html',
  styleUrl: './app.scss',
})
export class App implements OnInit {
  readonly data = inject(DataService);
  readonly themeSvc = inject(ThemeService);
  private readonly settings = inject(SettingsService);

  // ---- dashboard layout (reorderable widgets) ----
  readonly editMode = signal(false);
  readonly defaultWidgets = [
    'timeseries', 'levels', 'status', 'endpoints', 'ips', 'urls',
    'httpcodes', 'service', 'sourcePie', 'endpointPie', 'drilldown', 'heatmap',
  ];
  readonly widgets = signal<string[]>(this.loadOrder());
  readonly dragKey = signal<string | null>(null);
  readonly overKey = signal<string | null>(null);

  private loadOrder(): string[] {
    const saved = this.settings.get<string[]>('widgetOrder', []);
    const known = new Set(this.defaultWidgets);
    const order = Array.isArray(saved) ? saved.filter((k) => known.has(k)) : [];
    // append any widget keys not present in the saved order (e.g. new features)
    for (const k of this.defaultWidgets) if (!order.includes(k)) order.push(k);
    return order;
  }

  widgetAvailable(key: string): boolean {
    switch (key) {
      case 'httpcodes':
        return this.data.topHttpCodes().length > 1;
      case 'service':
        return this.data.byService().length > 1;
      default:
        return true;
    }
  }

  widgetSpan(key: string): string {
    if (key === 'heatmap') return 'span-3';
    if (key === 'timeseries' || key === 'urls' || key === 'drilldown') return 'span-2';
    // pies widen when showing many slices so legends fit
    if (key === 'sourcePie') return this.sourcePieLimit() === 10 ? '' : 'span-2';
    if (key === 'endpointPie') return this.endpointPieLimit() === 10 ? '' : 'span-2';
    return '';
  }

  /** Number of legend rows a pie will show (top N + "прочие"). */
  pieSlices(total: number, limit: number): number {
    return limit > 0 ? Math.min(limit + 1, total) : total;
  }

  /** Height for a doughnut so its right-side legend fits all slices. */
  pieHeight(n: number): number {
    return Math.min(760, Math.max(280, n * 22 + 40));
  }

  // ===================== Fullscreen / presentation mode =====================
  readonly focusedWidget = signal<string | null>(null);
  readonly fsHeight = signal<number>(620);

  private readonly WIDGET_TITLES: Record<string, string> = {
    timeseries: 'Динамика запросов и ошибок',
    levels: 'Уровни логов',
    status: 'Классы HTTP-статусов',
    endpoints: 'Топ эндпоинтов (nr_dic)',
    ips: 'Топ источников (IP)',
    urls: 'Топ URL',
    httpcodes: 'HTTP-коды',
    service: 'По сервисам',
    sourcePie: 'Доли по источникам',
    endpointPie: 'Доли по эндпоинтам',
    drilldown: 'Эндпоинты выбранного источника',
    heatmap: 'Активность по времени',
  };

  /** Ordered, currently-available widget keys (for presentation navigation). */
  readonly focusList = computed(() => this.widgets().filter((k) => this.widgetAvailable(k)));

  widgetTitle(key: string): string {
    return this.WIDGET_TITLES[key] ?? key;
  }

  openFocus(key: string): void {
    this.updateFsHeight();
    this.focusedWidget.set(key);
  }
  closeFocus(): void {
    this.focusedWidget.set(null);
  }
  focusStep(dir: number): void {
    const list = this.focusList();
    const cur = this.focusedWidget();
    if (!cur || !list.length) return;
    const idx = (list.indexOf(cur) + dir + list.length) % list.length;
    this.focusedWidget.set(list[idx]);
  }
  focusPos(): string {
    const list = this.focusList();
    const cur = this.focusedWidget();
    const i = cur ? list.indexOf(cur) : -1;
    return i >= 0 ? `${i + 1} / ${list.length}` : '';
  }

  private updateFsHeight(): void {
    this.fsHeight.set(Math.max(320, window.innerHeight - 170));
  }

  /** A canvas exists to export (heatmap card view is plain DOM). */
  canExportPng(): boolean {
    const k = this.focusedWidget();
    if (!k) return false;
    return !(k === 'heatmap' && this.activityView() === 'heatmap');
  }

  exportPng(): void {
    const c = document.querySelector('.focus__body canvas') as HTMLCanvasElement | null;
    if (!c) return;
    const a = document.createElement('a');
    a.href = c.toDataURL('image/png');
    a.download = (this.focusedWidget() || 'chart') + '.png';
    a.click();
  }

  async exportPdf(): Promise<void> {
    const api = (window as unknown as { metricsAPI?: { exportPdf?: () => Promise<{ ok?: boolean }> } }).metricsAPI;
    if (!api?.exportPdf) return;
    const res = await api.exportPdf();
    if (res?.ok) this.showToast('PDF сохранён');
  }

  @HostListener('window:resize')
  onResize(): void {
    if (this.focusedWidget()) this.updateFsHeight();
  }

  @HostListener('document:keydown', ['$event'])
  onKey(ev: KeyboardEvent): void {
    if (!this.focusedWidget()) return;
    if (ev.key === 'Escape') this.closeFocus();
    else if (ev.key === 'ArrowRight') this.focusStep(1);
    else if (ev.key === 'ArrowLeft') this.focusStep(-1);
  }

  onDragStart(ev: DragEvent, key: string): void {
    this.dragKey.set(key);
    if (ev.dataTransfer) {
      ev.dataTransfer.effectAllowed = 'move';
      ev.dataTransfer.setData('text/plain', key);
    }
  }
  onDragOver(ev: DragEvent, key: string): void {
    if (!this.editMode()) return;
    ev.preventDefault();
    if (this.overKey() !== key) this.overKey.set(key);
  }
  onDrop(key: string): void {
    const from = this.dragKey();
    if (from && from !== key) {
      const arr = this.widgets().filter((k) => k !== from);
      arr.splice(arr.indexOf(key), 0, from);
      this.widgets.set(arr);
      this.settings.set('widgetOrder', arr);
    }
    this.endDrag();
  }
  onDragEnd(): void {
    this.endDrag();
  }
  private endDrag(): void {
    this.dragKey.set(null);
    this.overKey.set(null);
  }
  resetOrder(): void {
    const order = [...this.defaultWidgets];
    this.widgets.set(order);
    this.settings.set('widgetOrder', order);
  }

  // table state
  readonly sortKey = signal<SortKey>('date');
  readonly sortDir = signal<'asc' | 'desc'>('desc');
  readonly page = signal(0);
  readonly pageSize = signal(50);
  readonly expandedId = signal<string | null>(null);

  // ui state
  readonly filtersOpen = signal(true);

  // debounced search inputs (avoid recomputing everything on each keystroke)
  readonly textInput = signal('');
  readonly ipInput = signal('');
  private textTimer: ReturnType<typeof setTimeout> | undefined;
  private ipTimer: ReturnType<typeof setTimeout> | undefined;

  // toast (e.g. data auto-reloaded)
  readonly toast = signal<string | null>(null);
  private toastTimer: ReturnType<typeof setTimeout> | undefined;

  ngOnInit(): void {
    this.data.loadMembers();
    this.data.loadDefault();
    const api = (window as unknown as { metricsAPI?: { onDataChanged?: (cb: () => void) => void } }).metricsAPI;
    api?.onDataChanged?.(() => {
      this.data.loadMembers();
      this.data.loadDefault();
      this.showToast('Данные обновлены');
    });
  }

  showToast(msg: string): void {
    this.toast.set(msg);
    clearTimeout(this.toastTimer);
    this.toastTimer = setTimeout(() => this.toast.set(null), 2600);
  }

  // ---- cross-filtering: click a chart element to filter the dashboard ----
  crossFilter(kind: CrossKind, value: string): void {
    if (!value || value === 'прочие' || value === '—') return;
    switch (kind) {
      case 'level':
        this.data.toggleSet(this.data.levels, value);
        break;
      case 'status':
        this.data.toggleSet(this.data.statusClasses, value);
        break;
      case 'endpoint':
        this.data.toggleSet(this.data.endpoints, value);
        break;
      case 'service':
        this.data.service.set(this.data.service() === value ? '' : value);
        break;
      case 'ip': {
        const nv = this.data.ipQuery() === value ? '' : value;
        this.data.ipQuery.set(nv);
        this.ipInput.set(nv);
        break;
      }
      case 'text': {
        const nv = this.data.textQuery() === value ? '' : value;
        this.data.textQuery.set(nv);
        this.textInput.set(nv);
        break;
      }
    }
    this.page.set(0);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private clickable(options: any, keys: () => string[], kind: CrossKind): any {
    return {
      ...options,
      onClick: (_e: unknown, els: { index: number }[]) => {
        if (els.length) {
          const k = keys()[els[0].index];
          if (k != null) this.crossFilter(kind, k);
        }
      },
      onHover: (e: { native?: { target?: HTMLElement } }, els: unknown[]) => {
        const t = e?.native?.target;
        if (t) t.style.cursor = els.length ? 'pointer' : 'default';
      },
    };
  }

  // ---- date input bindings (string <-> epoch) ----
  get fromInput(): string {
    return this.toLocalInput(this.data.dateFrom());
  }
  set fromInput(v: string) {
    this.data.dateFrom.set(v ? new Date(v).getTime() : null);
    this.page.set(0);
  }
  get toInput(): string {
    return this.toLocalInput(this.data.dateTo());
  }
  set toInput(v: string) {
    this.data.dateTo.set(v ? new Date(v).getTime() : null);
    this.page.set(0);
  }

  quickRange(hours: number | 'all'): void {
    if (hours === 'all') {
      this.data.dateFrom.set(null);
      this.data.dateTo.set(null);
      this.page.set(0);
      return;
    }
    const range = this.data.dataRange();
    const anchor = range ? range.max : Date.now();
    this.data.dateTo.set(anchor);
    this.data.dateFrom.set(anchor - hours * 36e5);
    this.page.set(0);
  }

  onFilterChange(): void {
    this.page.set(0);
  }

  onTextSearch(v: string): void {
    this.textInput.set(v);
    clearTimeout(this.textTimer);
    this.textTimer = setTimeout(() => {
      this.data.textQuery.set(v);
      this.page.set(0);
    }, 250);
  }

  onIpSearch(v: string): void {
    this.ipInput.set(v);
    clearTimeout(this.ipTimer);
    this.ipTimer = setTimeout(() => {
      this.data.ipQuery.set(v);
      this.page.set(0);
    }, 250);
  }

  resetAll(): void {
    this.textInput.set('');
    this.ipInput.set('');
    this.data.resetFilters();
    this.page.set(0);
  }

  // ---- sorted + paged rows ----
  readonly sorted = computed<LogRow[]>(() => {
    const rows = [...this.data.filtered()];
    const key = this.sortKey();
    const dir = this.sortDir() === 'asc' ? 1 : -1;
    rows.sort((a, b) => {
      let av: number | string;
      let bv: number | string;
      switch (key) {
        case 'date':
          av = isNaN(a.ts) ? -Infinity : a.ts;
          bv = isNaN(b.ts) ? -Infinity : b.ts;
          break;
        case 'httpCode':
          av = isNaN(a.httpCode) ? -1 : a.httpCode;
          bv = isNaN(b.httpCode) ? -1 : b.httpCode;
          break;
        case 'level':
          av = a.level;
          bv = b.level;
          break;
        case 'service':
          av = a.service;
          bv = b.service;
          break;
        case 'nrDic':
          av = a.nrDic;
          bv = b.nrDic;
          break;
        case 'ip':
          av = a.ip;
          bv = b.ip;
          break;
      }
      if (av < bv) return -1 * dir;
      if (av > bv) return 1 * dir;
      return 0;
    });
    return rows;
  });

  readonly totalPages = computed(() => Math.max(1, Math.ceil(this.sorted().length / this.pageSize())));
  readonly pagedRows = computed<LogRow[]>(() => {
    const start = this.page() * this.pageSize();
    return this.sorted().slice(start, start + this.pageSize());
  });

  setSort(key: SortKey): void {
    if (this.sortKey() === key) {
      this.sortDir.update((d) => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      this.sortKey.set(key);
      this.sortDir.set(key === 'date' ? 'desc' : 'asc');
    }
  }

  sortArrow(key: SortKey): string {
    if (this.sortKey() !== key) return '';
    return this.sortDir() === 'asc' ? '▲' : '▼';
  }

  prevPage(): void {
    this.page.update((p) => Math.max(0, p - 1));
  }
  nextPage(): void {
    this.page.update((p) => Math.min(this.totalPages() - 1, p + 1));
  }
  toggleRow(id: string): void {
    this.expandedId.update((cur) => (cur === id ? null : id));
  }

  // ===================== CHART CONFIGS =====================
  readonly timeSeriesConfig = computed<ChartConfiguration<'line'>>(() => {
    const p = this.themeSvc.palette();
    const buckets = this.data.timeSeries();
    return {
      type: 'line',
      data: {
        labels: buckets.map((b) => b.label),
        datasets: [
          {
            label: 'Запросы',
            data: buckets.map((b) => b.total),
            borderColor: p.accent,
            backgroundColor: this.gradientFill(p.accent),
            fill: true,
            tension: 0.35,
            borderWidth: 2,
            pointRadius: buckets.length > 60 ? 0 : 2,
            pointHoverRadius: 4,
          },
          {
            label: 'Ошибки',
            data: buckets.map((b) => b.errors),
            borderColor: p.series[5],
            backgroundColor: 'transparent',
            fill: false,
            tension: 0.35,
            borderWidth: 2,
            pointRadius: buckets.length > 60 ? 0 : 2,
            pointHoverRadius: 4,
          },
        ],
      },
      options: this.lineOptions(p),
    };
  });

  readonly levelConfig = computed<ChartConfiguration<'doughnut'>>(() => {
    const p = this.themeSvc.palette();
    const items = this.data.byLevel();
    return {
      type: 'doughnut',
      data: {
        labels: items.map((i) => i.key),
        datasets: [
          {
            data: items.map((i) => i.count),
            backgroundColor: items.map((i) => this.levelColor(i.key, p)),
            borderColor: p.surface,
            borderWidth: 2,
            hoverOffset: 6,
          },
        ],
      },
      options: this.clickable(this.doughnutOptions(p), () => items.map((i) => i.key), 'level'),
    };
  });

  readonly statusClassConfig = computed<ChartConfiguration<'bar'>>(() => {
    const p = this.themeSvc.palette();
    const items = this.data.byStatusClass();
    return {
      type: 'bar',
      data: {
        labels: items.map((i) => i.key),
        datasets: [
          {
            label: 'Запросы',
            data: items.map((i) => i.count),
            backgroundColor: items.map((i) => this.statusColor(i.key, p)),
            borderRadius: 6,
            maxBarThickness: 64,
            minBarLength: 3,
          },
        ],
      },
      options: this.clickable(this.barOptions(p), () => items.map((i) => i.key), 'status'),
    };
  });

  readonly httpCodesConfig = computed<ChartConfiguration<'bar'>>(() => {
    const p = this.themeSvc.palette();
    const items = this.data.topHttpCodes();
    return {
      type: 'bar',
      data: {
        labels: items.map((i) => i.key),
        datasets: [
          {
            label: 'Запросы',
            data: items.map((i) => i.count),
            backgroundColor: items.map((i) => this.statusColor((i.key[0] ?? '') + 'xx', p)),
            borderRadius: 6,
            maxBarThickness: 48,
            minBarLength: 3,
          },
        ],
      },
      options: this.barOptions(p),
    };
  });

  readonly endpointsConfig = computed<ChartConfiguration<'bar'>>(() => {
    const raw = this.data.topEndpoints();
    const cfg = this.hbarConfig(raw, 'Запросы');
    cfg.options = this.clickable(cfg.options, () => raw.map((i) => i.key), 'endpoint');
    return cfg;
  });
  readonly ipsConfig = computed<ChartConfiguration<'bar'>>(() => {
    const raw = this.data.topIps();
    const cfg = this.hbarConfig(
      raw.map((i) => ({ key: this.data.sourceLabel(i.key), count: i.count })),
      'Запросы',
    );
    cfg.options = this.clickable(cfg.options, () => raw.map((i) => i.key), 'ip');
    return cfg;
  });

  readonly sourcePieLimit = signal(10);
  readonly endpointPieLimit = signal(10);
  readonly pieLimitOptions = [10, 20, 0]; // 0 = все

  readonly sourcePieConfig = computed<ChartConfiguration<'doughnut'>>(() =>
    this.doughnutFrom(
      this.data.bySource().map((i) => ({ key: this.data.sourceLabel(i.key), count: i.count })),
      this.sourcePieLimit(),
    ),
  );
  readonly endpointPieConfig = computed<ChartConfiguration<'doughnut'>>(() =>
    this.doughnutFrom(this.data.byEndpoint(), this.endpointPieLimit(), 'endpoint'),
  );
  readonly sourceEndpointsConfig = computed<ChartConfiguration<'bar'>>(() =>
    this.hbarConfig(this.data.sourceEndpoints(), 'Запросы'),
  );
  readonly sourceTotal = computed(() => this.data.sourceEndpoints().reduce((s, i) => s + i.count, 0));
  readonly tsTotals = computed(() => this.data.timeSeries().map((b) => b.total));
  readonly tsErrors = computed(() => this.data.timeSeries().map((b) => b.errors));
  readonly urlsConfig = computed<ChartConfiguration<'bar'>>(() => {
    const raw = this.data.topUrls();
    const cfg = this.hbarConfig(raw, 'Запросы');
    cfg.options = this.clickable(cfg.options, () => raw.map((i) => i.key), 'text');
    return cfg;
  });
  // Activity: overlay one line per weekday over the time-of-day axis.
  readonly activityView = signal<'overlay' | 'heatmap'>(this.settings.get('activityView', 'overlay'));
  readonly activityDays = signal<'all' | 'weekdays' | 'weekend'>(this.settings.get('activityDays', 'all'));

  setActivityView(v: 'overlay' | 'heatmap'): void {
    this.activityView.set(v);
    this.settings.set('activityView', v);
  }
  setActivityDays(v: 'all' | 'weekdays' | 'weekend'): void {
    this.activityDays.set(v);
    this.settings.set('activityDays', v);
  }

  readonly activityOverlayConfig = computed<ChartConfiguration<'line'>>(() => {
    const p = this.themeSvc.palette();
    const hm = this.data.heatmap();
    const mode = this.activityDays();
    const include =
      mode === 'weekdays' ? [0, 1, 2, 3, 4] : mode === 'weekend' ? [5, 6] : [0, 1, 2, 3, 4, 5, 6];
    const rows = hm.rows.filter((r) => include.includes(r.day));
    const pr = hm.cols > 24 ? 0 : 2;

    // thin per-weekday lines
    const datasets = rows.map((row) => ({
      label: row.label,
      data: row.cells,
      borderColor: p.series[row.day % p.series.length],
      backgroundColor: 'transparent',
      borderWidth: 1.5,
      tension: 0.35,
      pointRadius: pr,
      pointHoverRadius: 4,
      fill: false,
    }));

    // bold average line on top
    const avg = new Array(hm.cols).fill(0);
    if (rows.length) {
      for (let c = 0; c < hm.cols; c++) {
        let s = 0;
        for (const r of rows) s += r.cells[c];
        avg[c] = Math.round((s / rows.length) * 10) / 10;
      }
    }
    datasets.push({
      label: 'среднее',
      data: avg,
      borderColor: p.text,
      backgroundColor: 'transparent',
      borderWidth: 3.5,
      tension: 0.35,
      pointRadius: 0,
      pointHoverRadius: 5,
      fill: false,
    } as (typeof datasets)[number]);

    return {
      type: 'line',
      data: { labels: hm.timeLabels, datasets },
      options: this.lineOptions(p),
    };
  });

  readonly serviceConfig = computed<ChartConfiguration<'doughnut'>>(() => {
    const p = this.themeSvc.palette();
    const items = this.data.byService();
    return {
      type: 'doughnut',
      data: {
        labels: items.map((i) => i.key),
        datasets: [
          {
            data: items.map((i) => i.count),
            backgroundColor: items.map((_, idx) => p.series[idx % p.series.length]),
            borderColor: p.surface,
            borderWidth: 2,
            hoverOffset: 6,
          },
        ],
      },
      options: this.clickable(this.doughnutOptions(p), () => items.map((i) => i.key), 'service'),
    };
  });

  // ---- chart option builders ----
  private hbarConfig(
    items: { key: string; count: number }[],
    label: string,
    danger = false,
  ): ChartConfiguration<'bar'> {
    const p = this.themeSvc.palette();
    return {
      type: 'bar',
      data: {
        labels: items.map((i) => i.key),
        datasets: [
          {
            label,
            data: items.map((i) => i.count),
            backgroundColor: danger ? p.series[5] : p.accent,
            borderRadius: 6,
            maxBarThickness: 26,
            minBarLength: 4,
          },
        ],
      },
      options: {
        ...this.barOptions(p),
        indexAxis: 'y',
      },
    };
  }

  /** Doughnut from a counted list: top N slices + an aggregated "прочие". */
  private doughnutFrom(
    items: { key: string; count: number }[],
    limit = 8,
    pickKind?: CrossKind,
  ): ChartConfiguration<'doughnut'> {
    const p = this.themeSvc.palette();
    const TOP = limit > 0 ? limit : items.length;
    let slices = items;
    if (items.length > TOP + 1) {
      const head = items.slice(0, TOP);
      const rest = items.slice(TOP).reduce((s, i) => s + i.count, 0);
      slices = [...head, { key: 'прочие', count: rest }];
    }
    return {
      type: 'doughnut',
      data: {
        labels: slices.map((s) => s.key),
        datasets: [
          {
            data: slices.map((s) => s.count),
            backgroundColor: slices.map((s, idx) =>
              s.key === 'прочие' ? p.textMuted : p.series[idx % p.series.length],
            ),
            borderColor: p.surface,
            borderWidth: 2,
            hoverOffset: 6,
          },
        ],
      },
      options: pickKind
        ? this.clickable(this.doughnutOptions(p), () => slices.map((s) => s.key), pickKind)
        : this.doughnutOptions(p),
    };
  }

  private lineOptions(p: ReturnType<ThemeService['palette']>): ChartConfiguration<'line'>['options'] {
    return {
      responsive: true,
      maintainAspectRatio: false,
      animation: { duration: 650, easing: 'easeOutQuart' },
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { labels: { color: p.text, usePointStyle: true, boxWidth: 8 } },
        tooltip: this.tooltipStyle(p),
      },
      scales: {
        x: {
          ticks: { color: p.textMuted, maxRotation: 0, autoSkip: true, maxTicksLimit: 12 },
          grid: { color: p.grid },
        },
        y: { beginAtZero: true, ticks: { color: p.textMuted, precision: 0 }, grid: { color: p.grid } },
      },
    };
  }

  private barOptions(p: ReturnType<ThemeService['palette']>): ChartConfiguration<'bar'>['options'] {
    return {
      responsive: true,
      maintainAspectRatio: false,
      animation: { duration: 650, easing: 'easeOutQuart' },
      plugins: { legend: { display: false }, tooltip: this.tooltipStyle(p) },
      scales: {
        x: { beginAtZero: true, ticks: { color: p.textMuted, precision: 0 }, grid: { color: p.grid } },
        y: { ticks: { color: p.textMuted }, grid: { display: false } },
      },
    };
  }

  private doughnutOptions(p: ReturnType<ThemeService['palette']>): ChartConfiguration<'doughnut'>['options'] {
    return {
      responsive: true,
      maintainAspectRatio: false,
      cutout: '62%',
      animation: { duration: 700, easing: 'easeOutQuart', animateRotate: true, animateScale: true },
      plugins: {
        legend: {
          position: 'right',
          labels: { color: p.text, usePointStyle: true, boxWidth: 8, padding: 12 },
        },
        tooltip: this.tooltipStyle(p),
      },
    };
  }

  private tooltipStyle(p: ReturnType<ThemeService['palette']>) {
    return {
      backgroundColor: p.surface,
      titleColor: p.text,
      bodyColor: p.text,
      borderColor: p.grid,
      borderWidth: 1,
      padding: 10,
      cornerRadius: 8,
    };
  }

  private gradientFill(
    hex: string,
  ): (ctx: {
    chart: { ctx: CanvasRenderingContext2D; chartArea?: { top: number; bottom: number } };
  }) => CanvasGradient | string {
    return (ctx) => {
      const { chart } = ctx;
      const area = chart.chartArea;
      if (!area) return hex + '22';
      const g = chart.ctx.createLinearGradient(0, area.top, 0, area.bottom);
      g.addColorStop(0, hex + '55');
      g.addColorStop(1, hex + '05');
      return g;
    };
  }

  private levelColor(level: string, p: ReturnType<ThemeService['palette']>): string {
    const l = level.toLowerCase();
    if (l.includes('error') || l.includes('fatal') || l.includes('crit')) return p.series[5];
    if (l.includes('warn')) return p.series[3];
    if (l.includes('info')) return p.series[0];
    if (l.includes('debug') || l.includes('trace')) return p.series[1];
    return p.series[6];
  }

  private statusColor(cls: string, p: ReturnType<ThemeService['palette']>): string {
    switch (cls) {
      case '2xx':
        return p.series[2];
      case '3xx':
        return p.series[1];
      case '4xx':
        return p.series[3];
      case '5xx':
        return p.series[5];
      case '1xx':
        return p.series[7];
      default:
        return p.textMuted;
    }
  }

  // ===================== formatting & misc =====================
  readonly granularities: { key: Granularity; label: string }[] = [
    { key: 'auto', label: 'авто' },
    { key: 'second', label: 'сек' },
    { key: 'minute', label: 'мин' },
    { key: 'hour', label: 'час' },
    { key: 'day', label: 'день' },
    { key: 'week', label: 'нед' },
    { key: 'month', label: 'мес' },
  ];

  readonly limitOptions = [15, 50, 100, 0]; // 0 = все
  readonly heatBuckets = [60, 30, 15, 10]; // minutes per heatmap column

  limitLabel(n: number): string {
    return n === 0 ? 'Все' : String(n);
  }

  /** Height for a horizontal "top" chart so every bar stays readable. */
  barHeight(n: number): number {
    return Math.max(220, n * 26 + 56);
  }

  setGranularity(g: Granularity): void {
    this.data.granularity.set(g);
  }

  fmtNum(n: number): string {
    return new Intl.NumberFormat('ru-RU').format(Math.round(n));
  }
  fmtPct(n: number): string {
    return (Math.round(n * 10) / 10).toFixed(1) + '%';
  }
  fmtDate(ms: number | null): string {
    if (ms == null) return '—';
    const d = new Date(ms);
    const p = (n: number) => String(n).padStart(2, '0');
    return `${p(d.getDate())}.${p(d.getMonth() + 1)}.${d.getFullYear()} ${p(d.getHours())}:${p(d.getMinutes())}`;
  }

  /** Member name for an ip, or the "unknown user" label. */
  displaySource(ip: string): string {
    return this.data.resolveName(ip) || this.data.UNKNOWN;
  }

  rowClass(r: LogRow): string {
    if (r.isError) return 'row--err';
    if (r.levelNorm.includes('warn')) return 'row--warn';
    return '';
  }

  badgeClass(r: LogRow): string {
    if (r.isError) return 'badge badge--err';
    if (r.levelNorm.includes('warn')) return 'badge badge--warn';
    if (r.levelNorm.includes('info')) return 'badge badge--info';
    return 'badge';
  }

  exportCsv(): void {
    const csv = this.data.exportFilteredCsv();
    const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8;' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'metrics-filtered.csv';
    a.click();
    URL.revokeObjectURL(a.href);
  }

  onFileInput(ev: Event): void {
    const input = ev.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => this.data.ingestText(String(reader.result), file.name);
    reader.readAsText(file);
    input.value = '';
  }

  private toLocalInput(ms: number | null): string {
    if (ms == null) return '';
    const d = new Date(ms);
    const p = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
  }
}
