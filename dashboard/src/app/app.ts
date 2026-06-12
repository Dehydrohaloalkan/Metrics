import { Component, computed, signal, inject, OnInit, ChangeDetectionStrategy } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ChartConfiguration } from 'chart.js';
import { DataService, Granularity } from './services/data.service';
import { ThemeService } from './services/theme.service';
import { ChartPanelComponent } from './components/chart-panel.component';
import { LogRow } from './models';

type SortKey = 'date' | 'level' | 'service' | 'nrDic' | 'httpCode' | 'ip';

@Component({
  selector: 'app-root',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule, ChartPanelComponent],
  templateUrl: './app.html',
  styleUrl: './app.scss',
})
export class App implements OnInit {
  readonly data = inject(DataService);
  readonly themeSvc = inject(ThemeService);

  // table state
  readonly sortKey = signal<SortKey>('date');
  readonly sortDir = signal<'asc' | 'desc'>('desc');
  readonly page = signal(0);
  readonly pageSize = signal(50);
  readonly expandedId = signal<string | null>(null);

  // ui state
  readonly filtersOpen = signal(true);

  ngOnInit(): void {
    this.data.loadDefault();
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
      options: this.doughnutOptions(p),
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
      options: this.barOptions(p),
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

  readonly endpointsConfig = computed<ChartConfiguration<'bar'>>(() =>
    this.hbarConfig(this.data.topEndpoints(), 'Запросы'),
  );
  readonly ipsConfig = computed<ChartConfiguration<'bar'>>(() => this.hbarConfig(this.data.topIps(), 'Запросы'));
  readonly urlsConfig = computed<ChartConfiguration<'bar'>>(() => this.hbarConfig(this.data.topUrls(), 'Запросы'));
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
      options: this.doughnutOptions(p),
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

  private lineOptions(p: ReturnType<ThemeService['palette']>): ChartConfiguration<'line'>['options'] {
    return {
      responsive: true,
      maintainAspectRatio: false,
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
