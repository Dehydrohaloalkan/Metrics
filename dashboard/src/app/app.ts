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
import { DataService, Granularity, SourceGroup, GROUP_COLORS } from './services/data.service';
import { ThemeService } from './services/theme.service';
import { SettingsService } from './services/settings.service';
import { ChartPanelComponent } from './components/chart-panel.component';
import { HeatmapComponent } from './components/heatmap.component';
import { CountComponent } from './components/count.component';
import { SparklineComponent } from './components/sparkline.component';
import { SelectComponent, SelectOption } from './components/select.component';
import { LogRow } from './models';

type SortKey = 'date' | 'level' | 'service' | 'nrDic' | 'httpCode' | 'ip';
type CrossKind = 'level' | 'status' | 'endpoint' | 'service' | 'ip' | 'text' | 'group' | 'dic';

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
    SelectComponent,
  ],
  templateUrl: './app.html',
  styleUrl: './app.scss',
})
export class App implements OnInit {
  readonly data = inject(DataService);
  readonly themeSvc = inject(ThemeService);
  private readonly settings = inject(SettingsService);

  // ---- dashboard layout (reorderable + hideable widgets) ----
  readonly editMode = signal(false);
  readonly defaultWidgets = [
    'timeseries', 'groups', 'groupTrend', 'statusTrend', 'pareto',
    'levels', 'status', 'dicStatus', 'endpoints', 'ips', 'urls',
    'httpcodes', 'service', 'sourcePie', 'endpointPie', 'drilldown',
    'endpointTrend', 'dicStatusTrend', 'heatmap',
  ];
  readonly hiddenWidgets = signal<Set<string>>(this.loadHidden());

  private loadHidden(): Set<string> {
    const saved = this.settings.get<string[]>('hiddenWidgets', []);
    return new Set(Array.isArray(saved) ? saved : []);
  }

  toggleWidgetHidden(key: string): void {
    const next = new Set(this.hiddenWidgets());
    if (next.has(key)) next.delete(key);
    else next.add(key);
    this.hiddenWidgets.set(next);
    this.settings.set('hiddenWidgets', [...next]);
  }
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
      case 'groups':
      case 'groupTrend':
        return this.data.sourceGroups().length > 0;
      case 'dicStatus':
        return this.data.byDicStatus().length > 0;
      case 'pareto':
        return this.data.sourcePareto().points.length > 1;
      case 'statusTrend':
        return this.data.statusTrend().series.length > 0;
      case 'endpointTrend':
        return this.data.endpointTimeSeries().series.length > 0;
      case 'dicStatusTrend':
        return this.data.dicStatusTrendData().series.length > 1;
      default:
        return true;
    }
  }

  widgetSpan(key: string): string {
    if (key === 'heatmap') return 'span-3';
    if (key === 'timeseries' || key === 'urls' || key === 'drilldown' ||
        key === 'groupTrend' || key === 'statusTrend' || key === 'pareto' ||
        key === 'endpointTrend' || key === 'dicStatusTrend') return 'span-2';
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
    groups: 'Запросы по группам источников',
    groupTrend: 'Динамика по группам',
    statusTrend: 'Состав статусов во времени',
    pareto: 'Концентрация нагрузки (Парето)',
    dicStatus: 'Бизнес-статусы (cd_dic_status)',
    levels: 'Уровни логов',
    status: 'Классы HTTP-статусов',
    endpoints: 'Топ эндпоинтов (nr_dic)',
    ips: 'Топ источников (IP)',
    urls: 'Топ URL',
    httpcodes: 'HTTP-коды',
    service: 'По сервисам',
    sourcePie: 'Доли по источникам / группам',
    endpointPie: 'Доли по эндпоинтам',
    drilldown: 'Эндпоинты выбранного источника',
    endpointTrend: 'Динамика по эндпоинтам (топ-6)',
    dicStatusTrend: 'Динамика бизнес-статусов',
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
    if (ev.key === 'Escape' && this.presetsMenuOpen()) {
      this.presetsMenuOpen.set(false);
      this.editingPreset.set(null);
      return;
    }
    if (!this.focusedWidget()) return;
    if (ev.key === 'Escape') this.closeFocus();
    else if (ev.key === 'ArrowRight') this.focusStep(1);
    else if (ev.key === 'ArrowLeft') this.focusStep(-1);
  }

  // Close the presets popover on any outside click.
  @HostListener('document:click', ['$event'])
  onDocClick(ev: MouseEvent): void {
    if (this.presetsMenuOpen() && !(ev.target as HTMLElement).closest('.pdrop')) {
      this.presetsMenuOpen.set(false);
      this.editingPreset.set(null);
    }
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

  // ===================== Source-group manager (modal) =====================
  readonly groupsModalOpen = signal(false);
  readonly draftGroups = signal<SourceGroup[]>([]);
  readonly groupSourceFilter = signal('');

  openGroups(): void {
    this.draftGroups.set(this.data.sourceGroups().map((g) => ({ ...g, members: [...g.members] })));
    this.groupSourceFilter.set('');
    this.groupsModalOpen.set(true);
  }
  closeGroups(): void {
    this.groupsModalOpen.set(false);
  }

  // Backdrop click closes the modal — but only when the press *started* on the
  // backdrop. Otherwise selecting text inside an input and releasing the mouse
  // outside the card would fire a click on the backdrop and close the modal.
  private modalPressOnBackdrop = false;
  onModalMouseDown(ev: MouseEvent): void {
    this.modalPressOnBackdrop = ev.target === ev.currentTarget;
  }
  onModalBackdropClick(ev: MouseEvent): void {
    if (ev.target === ev.currentTarget && this.modalPressOnBackdrop) this.closeGroups();
  }
  addGroup(): void {
    const groups = this.draftGroups();
    const color = GROUP_COLORS[groups.length % GROUP_COLORS.length];
    this.draftGroups.set([
      ...groups,
      { id: 'g' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6), name: 'Новая группа', color, members: [] },
    ]);
  }
  removeGroup(id: string): void {
    this.draftGroups.set(this.draftGroups().filter((g) => g.id !== id));
  }
  renameGroup(id: string, name: string): void {
    this.draftGroups.set(this.draftGroups().map((g) => (g.id === id ? { ...g, name } : g)));
  }
  recolorGroup(id: string, color: string): void {
    this.draftGroups.set(this.draftGroups().map((g) => (g.id === id ? { ...g, color } : g)));
  }
  /** Group id that currently owns this ip in the draft, or '' if none. */
  draftGroupOf(ip: string): string {
    return this.draftGroups().find((g) => g.members.includes(ip))?.id ?? '';
  }
  /** Move a source into a group (or out of all when groupId is ''). */
  assignSource(ip: string, groupId: string): void {
    this.draftGroups.set(
      this.draftGroups().map((g) => {
        const without = g.members.filter((m) => m !== ip);
        if (g.id === groupId) return { ...g, members: [...without, ip] };
        return { ...g, members: without };
      }),
    );
  }
  saveGroupsModal(): void {
    this.data.saveGroups(this.draftGroups().filter((g) => g.name.trim()));
    this.groupsModalOpen.set(false);
  }
  filteredGroupSources() {
    const q = this.groupSourceFilter().trim().toLowerCase();
    const list = this.data.allSources();
    if (!q) return list.slice(0, 200);
    return list
      .filter((s) => s.key.toLowerCase().includes(q) || this.data.resolveName(s.key).toLowerCase().includes(q))
      .slice(0, 200);
  }

  // ===================== Saved filter presets =====================
  readonly presetName = signal('');
  readonly presetsMenuOpen = signal(false);
  readonly editingPreset = signal<string | null>(null);
  readonly editPresetName = signal('');
  /** Name of the preset currently applied (shown on the dropdown button). */
  readonly activePreset = signal<string | null>(null);

  saveCurrentPreset(): void {
    const name = this.presetName().trim();
    if (!name) return;
    this.data.savePreset(name);
    this.activePreset.set(name);
    this.presetName.set('');
  }
  applyPreset(name: string): void {
    if (!name) return;
    this.data.applyPreset(name);
    this.syncDraftFromService();
    this.activePreset.set(name);
    this.page.set(0);
    this.presetsMenuOpen.set(false);
  }
  /** Overwrite a preset with the currently-applied filters. */
  updatePreset(name: string): void {
    this.data.updatePreset(name);
    this.showToast(`Пресет «${name}» обновлён`);
  }
  removePreset(name: string): void {
    this.data.deletePreset(name);
    if (this.editingPreset() === name) this.editingPreset.set(null);
    if (this.activePreset() === name) this.activePreset.set(null);
  }
  startRenamePreset(name: string): void {
    this.editingPreset.set(name);
    this.editPresetName.set(name);
  }
  commitRenamePreset(oldName: string): void {
    const next = this.editPresetName().trim();
    this.data.renamePreset(oldName, next);
    if (next && this.activePreset() === oldName) this.activePreset.set(next);
    this.editingPreset.set(null);
  }

  // ===================== Dropdown option lists =====================
  readonly serviceOptions = computed<SelectOption[]>(() => [
    { value: '', label: 'Все сервисы' },
    ...this.data.allServices().map((s) => ({ value: s, label: s })),
  ]);
  readonly groupFilterOptions = computed<SelectOption[]>(() => [
    { value: '', label: 'Все группы' },
    ...this.data.sourceGroups().map((g) => ({ value: g.id, label: g.name, color: g.color })),
    { value: this.data.UNGROUPED, label: 'Без группы' },
  ]);
  /** Searchable list of every known source IP (label = IP, sub = name + count). */
  readonly ipFilterOptions = computed<SelectOption[]>(() => [
    { value: '', label: '— любой IP —' },
    ...this.data.allSources().map((s) => ({
      value: s.key,
      label: s.key,
      sub: `${this.displaySource(s.key)} · ${this.fmtNum(s.count)}`,
    })),
  ]);
  /** Distinct source *names* (many IPs may share one name). */
  readonly nameFilterOptions = computed<SelectOption[]>(() => {
    const byName = new Map<string, { ips: Set<string>; count: number }>();
    for (const s of this.data.allSources()) {
      const nm = this.data.resolveName(s.key);
      if (!nm) continue;
      let e = byName.get(nm);
      if (!e) {
        e = { ips: new Set(), count: 0 };
        byName.set(nm, e);
      }
      e.ips.add(s.key);
      e.count += s.count;
    }
    return [
      { value: '', label: '— любое имя —' },
      ...[...byName.entries()]
        .sort((a, b) => b[1].count - a[1].count)
        .map(([nm, e]) => ({ value: nm, label: nm, sub: `${e.ips.size} IP · ${this.fmtNum(e.count)}` })),
    ];
  });
  readonly drilldownOptions = computed<SelectOption[]>(() =>
    this.data.bySource().map((s) => ({
      value: s.key,
      label: this.data.sourceLabel(s.key),
      sub: this.fmtNum(s.count),
    })),
  );
  readonly pageSizeOptions: SelectOption[] = [
    { value: '25', label: '25' },
    { value: '50', label: '50' },
    { value: '100', label: '100' },
    { value: '250', label: '250' },
  ];
  /** Group-assignment options for the source-group manager modal. */
  readonly assignOptions = computed<SelectOption[]>(() => [
    { value: '', label: '— без группы —' },
    ...this.draftGroups().map((g) => ({ value: g.id, label: g.name, color: g.color })),
  ]);

  /** Pick an exact IP from the dropdown → stage it as the IP filter. */
  pickSource(ip: string): void {
    this.draftIpQuery.set(ip);
    this.ipInput.set(ip);
    this.showToast(
      ip ? `Добавлено в фильтр — IP: ${ip}. Нажмите «Применить»` : 'Фильтр по IP снят',
    );
  }
  /** Pick a source name from the dropdown → stage it as the name filter. */
  pickSourceName(name: string): void {
    this.draftNameQuery.set(name);
    this.nameInput.set(name);
    this.showToast(
      name ? `Добавлено в фильтр — имя: ${name}. Нажмите «Применить»` : 'Фильтр по имени снят',
    );
  }

  // ===================== Unapplied (pending) filter markers =====================
  // True when a control's staged value differs from what's currently applied.
  private setEq(a: Set<string>, b: Set<string>): boolean {
    if (a.size !== b.size) return false;
    for (const v of a) if (!b.has(v)) return false;
    return true;
  }
  readonly pendingDates = computed(
    () => this.draftFrom() !== this.data.dateFrom() || this.draftTo() !== this.data.dateTo(),
  );
  readonly pendingService = computed(() => this.draftService() !== this.data.service());
  readonly pendingGroup = computed(() => this.draftGroupFilter() !== this.data.groupFilter());
  readonly pendingIp = computed(() => this.draftIpQuery() !== this.data.ipQuery());
  readonly pendingName = computed(() => this.draftNameQuery() !== this.data.nameQuery());
  readonly pendingText = computed(() => this.draftTextQuery() !== this.data.textQuery());
  readonly pendingErrors = computed(() => this.draftOnlyErrors() !== this.data.onlyErrors());
  readonly pendingLevels = computed(() => !this.setEq(this.draftLevels(), this.data.levels()));
  readonly pendingStatus = computed(() => !this.setEq(this.draftStatusClasses(), this.data.statusClasses()));
  readonly pendingDic = computed(() => !this.setEq(this.draftDicStatuses(), this.data.dicStatuses()));
  readonly pendingEndpoints = computed(() => !this.setEq(this.draftEndpoints(), this.data.endpoints()));

  // table state
  readonly sortKey = signal<SortKey>('date');
  readonly sortDir = signal<'asc' | 'desc'>('desc');
  readonly page = signal(0);
  readonly pageSize = signal(50);
  readonly expandedId = signal<string | null>(null);

  // ui state
  readonly filtersOpen = signal(true);

  // ---- Draft filter state — not applied until commitFilters() ----
  readonly draftFrom = signal<number | null>(null);
  readonly draftTo = signal<number | null>(null);
  readonly draftLevels = signal<Set<string>>(new Set());
  readonly draftStatusClasses = signal<Set<string>>(new Set());
  readonly draftService = signal('');
  readonly draftEndpoints = signal<Set<string>>(new Set());
  readonly draftDicStatuses = signal<Set<string>>(new Set());
  readonly draftGroupFilter = signal('');
  readonly draftIpQuery = signal('');
  readonly draftNameQuery = signal('');
  readonly draftTextQuery = signal('');
  readonly draftOnlyErrors = signal(false);

  // local display bindings for text inputs
  readonly textInput = signal('');
  readonly ipInput = signal('');
  readonly nameInput = signal('');

  readonly hasDraftChanges = computed(() => {
    const s = (v: Set<string>) => [...v].sort().join('\0');
    return this.draftFrom() !== this.data.dateFrom()
      || this.draftTo() !== this.data.dateTo()
      || s(this.draftLevels()) !== s(this.data.levels())
      || s(this.draftStatusClasses()) !== s(this.data.statusClasses())
      || this.draftService() !== this.data.service()
      || s(this.draftEndpoints()) !== s(this.data.endpoints())
      || s(this.draftDicStatuses()) !== s(this.data.dicStatuses())
      || this.draftGroupFilter() !== this.data.groupFilter()
      || this.draftIpQuery() !== this.data.ipQuery()
      || this.draftNameQuery() !== this.data.nameQuery()
      || this.draftTextQuery() !== this.data.textQuery()
      || this.draftOnlyErrors() !== this.data.onlyErrors();
  });

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

  // ---- cross-filtering: click a chart element to *stage* a filter ----
  // Clicks add to the draft filters instead of applying immediately, so several
  // charts can be clicked and then committed together via «Применить».
  crossFilter(kind: CrossKind, value: string): void {
    if (!value || value === 'прочие' || value === '—') return;
    let toastMsg = '';
    switch (kind) {
      case 'level':
        this.draftToggleSet(this.draftLevels, value);
        toastMsg = `Уровень: ${value}`;
        break;
      case 'status':
        this.draftToggleSet(this.draftStatusClasses, value);
        toastMsg = `HTTP-статус: ${value}`;
        break;
      case 'endpoint':
        this.draftToggleSet(this.draftEndpoints, value);
        toastMsg = `Эндпоинт: ${value}`;
        break;
      case 'service':
        this.draftService.set(this.draftService() === value ? '' : value);
        toastMsg = `Сервис: ${value}`;
        break;
      case 'ip': {
        const nv = this.draftIpQuery() === value ? '' : value;
        this.draftIpQuery.set(nv);
        this.ipInput.set(nv);
        toastMsg = nv ? `IP: ${value}` : 'Фильтр по IP снят';
        break;
      }
      case 'text': {
        const nv = this.draftTextQuery() === value ? '' : value;
        this.draftTextQuery.set(nv);
        this.textInput.set(nv);
        toastMsg = nv ? `Текст: ${value}` : 'Текстовый фильтр снят';
        break;
      }
      case 'group':
        this.draftGroupFilter.set(this.draftGroupFilter() === value ? '' : value);
        toastMsg = `Группа: ${this.data.groupName(value)}`;
        break;
      case 'dic':
        this.draftToggleSet(this.draftDicStatuses, value);
        toastMsg = `Бизнес-статус: ${value}`;
        break;
    }
    if (toastMsg) this.showToast('Добавлено в фильтр — ' + toastMsg + '. Нажмите «Применить»');
  }

  /** Discard staged (draft) filter changes, reverting to what's currently applied. */
  cancelDraft(): void {
    this.syncDraftFromService();
  }

  // Generic "click an element → run handler(index)" wiring + pointer cursor.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private withClick(options: any, handler: (i: number) => void, byDataset = false): any {
    return {
      ...options,
      onClick: (_e: unknown, els: { index: number; datasetIndex: number }[]) => {
        if (els.length) {
          const e = els[0];
          handler(byDataset ? e.datasetIndex : e.index);
        }
      },
      onHover: (e: { native?: { target?: HTMLElement } }, els: unknown[]) => {
        const t = e?.native?.target;
        if (t) t.style.cursor = els.length ? 'pointer' : 'default';
      },
    };
  }

  // Click a bar/slice (indexed by element index) → cross-filter.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private clickable(options: any, keys: () => string[], kind: CrossKind): any {
    return this.withClick(options, (i) => {
      const k = keys()[i];
      if (k != null) this.crossFilter(kind, k);
    });
  }

  // Click a line/series (indexed by datasetIndex) → cross-filter. Used by the
  // multi-series trend charts, which run in "nearest" hover mode.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private clickableDataset(options: any, keys: () => string[], kind: CrossKind): any {
    return this.withClick(
      options,
      (i) => {
        const k = keys()[i];
        if (k != null) this.crossFilter(kind, k);
      },
      true,
    );
  }

  /** Click a point on the time-series → stage a date-range filter for that bucket. */
  onTimeBucketClick(i: number): void {
    const b = this.data.timeSeries();
    const bucket = b[i];
    if (!bucket) return;
    const span = b.length > 1 ? b[1].start - b[0].start : 36e5;
    const start = bucket.start;
    const end = b[i + 1]?.start ?? start + span;
    this.draftFrom.set(start);
    this.draftTo.set(end - 1);
    this.showToast('Добавлено в фильтр — период: ' + bucket.label + '. Нажмите «Применить»');
  }

  // ---- draft filter commit / sync ----
  commitFilters(): void {
    this.data.dateFrom.set(this.draftFrom());
    this.data.dateTo.set(this.draftTo());
    this.data.levels.set(new Set(this.draftLevels()));
    this.data.statusClasses.set(new Set(this.draftStatusClasses()));
    this.data.service.set(this.draftService());
    this.data.endpoints.set(new Set(this.draftEndpoints()));
    this.data.dicStatuses.set(new Set(this.draftDicStatuses()));
    this.data.groupFilter.set(this.draftGroupFilter());
    this.data.ipQuery.set(this.draftIpQuery());
    this.data.nameQuery.set(this.draftNameQuery());
    this.data.textQuery.set(this.draftTextQuery());
    this.data.onlyErrors.set(this.draftOnlyErrors());
    // A manual apply may diverge from the preset that was loaded.
    this.activePreset.set(null);
    this.page.set(0);
  }

  syncDraftFromService(): void {
    this.draftFrom.set(this.data.dateFrom());
    this.draftTo.set(this.data.dateTo());
    this.draftLevels.set(new Set(this.data.levels()));
    this.draftStatusClasses.set(new Set(this.data.statusClasses()));
    this.draftService.set(this.data.service());
    this.draftEndpoints.set(new Set(this.data.endpoints()));
    this.draftDicStatuses.set(new Set(this.data.dicStatuses()));
    this.draftGroupFilter.set(this.data.groupFilter());
    this.draftIpQuery.set(this.data.ipQuery());
    this.draftNameQuery.set(this.data.nameQuery());
    this.draftTextQuery.set(this.data.textQuery());
    this.draftOnlyErrors.set(this.data.onlyErrors());
    this.textInput.set(this.data.textQuery());
    this.ipInput.set(this.data.ipQuery());
    this.nameInput.set(this.data.nameQuery());
  }

  draftToggleSet(sig: ReturnType<typeof signal<Set<string>>>, value: string): void {
    const next = new Set(sig());
    if (next.has(value)) next.delete(value);
    else next.add(value);
    sig.set(next);
  }

  // ---- date input bindings (string <-> draft epoch) ----
  get fromInput(): string {
    return this.toLocalInput(this.draftFrom());
  }
  set fromInput(v: string) {
    this.draftFrom.set(v ? new Date(v).getTime() : null);
  }
  get toInput(): string {
    return this.toLocalInput(this.draftTo());
  }
  set toInput(v: string) {
    this.draftTo.set(v ? new Date(v).getTime() : null);
  }

  quickRange(hours: number | 'all'): void {
    if (hours === 'all') {
      this.data.dateFrom.set(null);
      this.data.dateTo.set(null);
    } else {
      const range = this.data.dataRange();
      const anchor = range ? range.max : Date.now();
      this.data.dateTo.set(anchor);
      this.data.dateFrom.set(anchor - hours * 36e5);
    }
    this.syncDraftFromService();
    this.page.set(0);
  }

  onTextSearch(v: string): void {
    this.textInput.set(v);
    this.draftTextQuery.set(v);
  }

  onIpSearch(v: string): void {
    this.ipInput.set(v);
    this.draftIpQuery.set(v);
  }

  onNameSearch(v: string): void {
    this.nameInput.set(v);
    this.draftNameQuery.set(v);
  }

  resetAll(): void {
    this.data.resetFilters();
    this.syncDraftFromService();
    this.activePreset.set(null);
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
    const pr = buckets.length > 60 ? 0 : 2;
    const opts = this.withClick(this.lineOptions(p), (i) => this.onTimeBucketClick(i));
    // add a right-hand axis for the error-rate %
    opts!.scales = {
      ...opts!.scales,
      rate: {
        position: 'right',
        beginAtZero: true,
        suggestedMax: 100,
        ticks: { color: p.textMuted, callback: (v: number | string) => v + '%' },
        grid: { drawOnChartArea: false },
      },
    };
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
            pointRadius: pr,
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
            pointRadius: pr,
            pointHoverRadius: 4,
          },
          {
            label: 'Доля ошибок, %',
            yAxisID: 'rate',
            data: buckets.map((b) => (b.total ? Math.round((b.errors / b.total) * 1000) / 10 : 0)),
            borderColor: p.series[3],
            backgroundColor: 'transparent',
            borderDash: [5, 4],
            fill: false,
            tension: 0.35,
            borderWidth: 1.5,
            pointRadius: 0,
            pointHoverRadius: 4,
          },
        ],
      },
      options: opts,
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
      // Clicking an HTTP code filters by its status class (e.g. 404 → 4xx).
      options: this.clickable(this.barOptions(p), () => items.map((i) => (i.key[0] ?? '') + 'xx'), 'status'),
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
  // Endpoint pie can show либо эндпоинты (nr_dic / ND) либо бизнес-статусы (cd_dic_status / CD).
  readonly endpointPieView = signal<'nd' | 'cd'>(this.settings.get('endpointPieView', 'nd'));
  setEndpointPieView(v: 'nd' | 'cd'): void {
    this.endpointPieView.set(v);
    this.settings.set('endpointPieView', v);
  }
  readonly endpointPieConfig = computed<ChartConfiguration<'doughnut'>>(() =>
    this.endpointPieView() === 'cd'
      ? this.doughnutFrom(this.data.byDicStatus(), this.endpointPieLimit(), 'dic')
      : this.doughnutFrom(this.data.byEndpoint(), this.endpointPieLimit(), 'endpoint'),
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

  // ===================== SOURCE GROUPS =====================
  readonly sourcePieView = signal<'groups' | 'sources'>(
    this.settings.get('sourcePieView', 'sources'),
  );
  setSourcePieView(v: 'groups' | 'sources'): void {
    this.sourcePieView.set(v);
    this.settings.set('sourcePieView', v);
  }
  readonly activePieConfig = computed<ChartConfiguration<'doughnut'>>(() =>
    this.sourcePieView() === 'groups' && this.data.sourceGroups().length > 0
      ? this.groupPieConfig()
      : this.sourcePieConfig(),
  );

  readonly groupBarConfig = computed<ChartConfiguration<'bar'>>(() => {
    const p = this.themeSvc.palette();
    const items = this.data.byGroup();
    const cfg: ChartConfiguration<'bar'> = {
      type: 'bar',
      data: {
        labels: items.map((i) => this.data.groupName(i.key)),
        datasets: [
          {
            label: 'Запросы',
            data: items.map((i) => i.count),
            backgroundColor: items.map((i) => this.data.groupColor(i.key)),
            borderRadius: 6,
            maxBarThickness: 46,
            minBarLength: 3,
          },
        ],
      },
      options: { ...this.barOptions(p), indexAxis: 'y' },
    };
    cfg.options = this.clickable(cfg.options, () => items.map((i) => i.key), 'group');
    return cfg;
  });

  readonly groupPieConfig = computed<ChartConfiguration<'doughnut'>>(() => {
    const p = this.themeSvc.palette();
    const items = this.data.byGroup();
    return {
      type: 'doughnut',
      data: {
        labels: items.map((i) => this.data.groupName(i.key)),
        datasets: [
          {
            data: items.map((i) => i.count),
            backgroundColor: items.map((i) => this.data.groupColor(i.key)),
            borderColor: p.surface,
            borderWidth: 2,
            hoverOffset: 6,
          },
        ],
      },
      options: this.clickable(this.doughnutOptions(p), () => items.map((i) => i.key), 'group'),
    };
  });

  readonly groupTrendConfig = computed<ChartConfiguration<'line'>>(() => {
    const p = this.themeSvc.palette();
    const ts = this.data.groupTimeSeries();
    const pr = ts.labels.length > 60 ? 0 : 2;
    return {
      type: 'line',
      data: {
        labels: ts.labels,
        datasets: ts.series.map((s) => ({
          label: s.name,
          data: s.data,
          borderColor: s.color,
          backgroundColor: 'transparent',
          fill: false,
          tension: 0.35,
          borderWidth: 2,
          pointRadius: pr,
          pointHoverRadius: 4,
        })),
      },
      options: this.clickableDataset(this.lineOptions(p, true), () => ts.series.map((s) => s.id), 'group'),
    };
  });

  readonly dicStatusConfig = computed<ChartConfiguration<'bar'>>(() => {
    const raw = this.data.topDicStatus();
    const cfg = this.hbarConfig(raw, 'Запросы');
    cfg.options = this.clickable(cfg.options, () => raw.map((i) => i.key), 'dic');
    return cfg;
  });

  readonly paretoConfig = computed<ChartConfiguration<'bar'>>(() => {
    const p = this.themeSvc.palette();
    const pts = this.data.sourcePareto().points;
    const short = (s: string) => (s.length > 22 ? s.slice(0, 21) + '…' : s);
    const opts = this.barOptions(p);
    opts!.scales = {
      ...opts!.scales,
      cum: {
        position: 'right',
        beginAtZero: true,
        max: 100,
        ticks: { color: p.textMuted, callback: (v: number | string) => v + '%' },
        grid: { drawOnChartArea: false },
      },
    };
    return {
      type: 'bar',
      data: {
        labels: pts.map((i) => short(i.key)),
        datasets: [
          {
            type: 'line',
            label: 'Накопленная доля, %',
            yAxisID: 'cum',
            data: pts.map((i) => Math.round(i.cumPct * 10) / 10),
            borderColor: p.series[3],
            backgroundColor: 'transparent',
            borderWidth: 2,
            tension: 0.3,
            pointRadius: 2,
          } as unknown as ChartConfiguration<'bar'>['data']['datasets'][number],
          {
            label: 'Запросы',
            data: pts.map((i) => i.count),
            backgroundColor: p.accent,
            borderRadius: 5,
            maxBarThickness: 34,
          },
        ],
      },
      options: this.clickable(opts, () => pts.map((i) => i.raw), 'ip'),
    };
  });

  readonly statusTrendConfig = computed<ChartConfiguration<'line'>>(() => {
    const p = this.themeSvc.palette();
    const ts = this.data.statusTrend();
    const pr = ts.labels.length > 60 ? 0 : 2;
    const opts = this.lineOptions(p, true);
    opts!.scales = {
      ...opts!.scales,
      y: { ...(opts!.scales as Record<string, unknown>)['y'] as object, stacked: true },
    };
    return {
      type: 'line',
      data: {
        labels: ts.labels,
        datasets: ts.series.map((s) => ({
          label: s.key,
          data: s.data,
          borderColor: this.statusColor(s.key, p),
          backgroundColor: this.statusColor(s.key, p) + '44',
          fill: true,
          stack: 'status',
          tension: 0.3,
          borderWidth: 1.5,
          pointRadius: pr,
          pointHoverRadius: 4,
        })),
      },
      options: this.clickableDataset(opts, () => ts.series.map((s) => s.key), 'status'),
    };
  });

  readonly endpointTrendConfig = computed<ChartConfiguration<'line'>>(() => {
    const p = this.themeSvc.palette();
    const ts = this.data.endpointTimeSeries();
    const pr = ts.labels.length > 60 ? 0 : 2;
    return {
      type: 'line',
      data: {
        labels: ts.labels,
        datasets: ts.series.map((s, i) => ({
          label: s.id,
          data: s.data,
          borderColor: p.series[i % p.series.length],
          backgroundColor: 'transparent',
          fill: false,
          tension: 0.35,
          borderWidth: 2,
          pointRadius: pr,
          pointHoverRadius: 4,
        })),
      },
      options: this.clickableDataset(this.lineOptions(p, true), () => ts.series.map((s) => s.id), 'endpoint'),
    };
  });

  readonly dicStatusTrendConfig = computed<ChartConfiguration<'line'>>(() => {
    const p = this.themeSvc.palette();
    const ts = this.data.dicStatusTrendData();
    const pr = ts.labels.length > 60 ? 0 : 2;
    // Plain (non-stacked, unfilled) lines so each business status is directly
    // comparable — the old stacked areas overlapped and exaggerated whichever
    // series was drawn on top.
    return {
      type: 'line',
      data: {
        labels: ts.labels,
        datasets: ts.series.map((s, i) => ({
          label: s.key,
          data: s.data,
          borderColor: p.series[i % p.series.length],
          backgroundColor: 'transparent',
          fill: false,
          tension: 0.35,
          borderWidth: 2,
          pointRadius: pr,
          pointHoverRadius: 4,
        })),
      },
      options: this.clickableDataset(this.lineOptions(p, true), () => ts.series.map((s) => s.key), 'dic'),
    };
  });

  // ---- chart option builders ----
  private wrapLabel(text: string, maxLen = 22, maxLines = 2): string | string[] {
    if (text.length <= maxLen) return text;
    const parts: string[] = [];
    let rem = text;
    while (rem.length > maxLen) {
      // Leave whatever is left for the final line once we're one line short.
      if (parts.length === maxLines - 1) break;
      let cut = -1;
      for (const d of [' ', '_', '/', '-', '.']) {
        const idx = rem.lastIndexOf(d, maxLen);
        if (idx > 0 && idx > cut) cut = idx;
      }
      if (cut < 1) cut = maxLen;
      parts.push(rem.slice(0, cut + (rem[cut] === ' ' ? 0 : 1)).trim());
      rem = rem.slice(cut + 1).trim();
    }
    if (rem) parts.push(rem);
    // Ellipsize the last line if it's still too long (e.g. a 150-char name).
    const last = parts.length - 1;
    if (parts[last] && parts[last].length > maxLen) {
      parts[last] = parts[last].slice(0, maxLen - 1).trimEnd() + '…';
    }
    return parts.length > 1 ? parts : parts[0];
  }

  private hbarConfig(
    items: { key: string; count: number }[],
    label: string,
    danger = false,
  ): ChartConfiguration<'bar'> {
    const p = this.themeSvc.palette();
    const opts = { ...this.barOptions(p), indexAxis: 'y' as const };
    // Show the *full* (untruncated) label on hover, since long names are
    // ellipsized on the axis.
    const tip = (opts.plugins ??= {}).tooltip as Record<string, unknown>;
    tip['callbacks'] = { title: (ctx: { dataIndex: number }[]) => items[ctx[0]?.dataIndex]?.key ?? '' };
    return {
      type: 'bar',
      data: {
        labels: items.map((i) => this.wrapLabel(i.key)),
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
      options: opts,
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
        labels: slices.map((s) => this.wrapLabel(s.key, 26)),
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

  private lineOptions(
    p: ReturnType<ThemeService['palette']>,
    compact = false,
  ): ChartConfiguration<'line'>['options'] {
    return {
      responsive: true,
      maintainAspectRatio: false,
      animation: { duration: 650, easing: 'easeOutQuart' },
      // "nearest" keeps the tooltip to a single series so it doesn't blanket the
      // chart — important for the many-line trend charts.
      interaction: compact
        ? { mode: 'nearest', intersect: false }
        : { mode: 'index', intersect: false },
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
        // autoSkip:false → every category label is drawn (don't silently drop rows).
        y: { ticks: { color: p.textMuted, autoSkip: false }, grid: { display: false } },
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
      padding: 8,
      cornerRadius: 8,
      // Smaller footprint + point-style swatches so the box covers less data.
      usePointStyle: true,
      boxWidth: 8,
      boxHeight: 8,
      boxPadding: 4,
      caretSize: 5,
      titleFont: { size: 11.5 },
      bodyFont: { size: 11.5 },
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
  readonly trendLimitOptions = [5, 10, 20, 0]; // 0 = все (для трендов)
  readonly heatBuckets = [60, 30, 15, 10]; // minutes per heatmap column

  limitLabel(n: number): string {
    return n === 0 ? 'Все' : String(n);
  }

  /** Height for a horizontal "top" chart so every bar (and its possibly
   *  two-line label) stays readable without overlapping its neighbour. */
  barHeight(n: number): number {
    return Math.max(220, n * 34 + 60);
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
