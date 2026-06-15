import {
  Component,
  ElementRef,
  HostListener,
  computed,
  inject,
  input,
  output,
  signal,
  ChangeDetectionStrategy,
} from '@angular/core';
import { FormsModule } from '@angular/forms';

export interface SelectOption {
  value: string;
  label: string;
  /** optional secondary line (e.g. IP / count) */
  sub?: string;
  /** optional colour swatch shown before the label */
  color?: string;
}

/**
 * Fully styled dropdown — replaces the native <select> so the *opened* option
 * list matches the dark UI (native popups can't be themed cross-platform).
 * Optional `searchable` turns it into a filterable picker.
 */
@Component({
  selector: 'app-select',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule],
  template: `
    <div class="sel" [class.sel--open]="open()" [style.width]="width() || null">
      <button type="button" class="sel__btn" [class.sel__btn--pending]="pending()" (click)="toggle()">
        @if (currentColor(); as c) {
          <span class="sel__dot" [style.background]="c"></span>
        }
        <span class="sel__value" [class.sel__value--ph]="!hasValue()">{{ currentLabel() }}</span>
        <span class="sel__caret">▾</span>
      </button>
      @if (open()) {
        <div
          class="sel__menu"
          [class.sel__menu--fixed]="fixed()"
          [style.position]="fixed() ? 'fixed' : null"
          [style.top.px]="fixed() ? menuPos().top : null"
          [style.left.px]="fixed() ? menuPos().left : null"
          [style.width.px]="fixed() ? menuPos().width : null"
        >
          @if (searchable()) {
            <input
              class="sel__search"
              type="text"
              [placeholder]="searchPlaceholder()"
              [ngModel]="query()"
              (ngModelChange)="query.set($event)"
              (click)="$event.stopPropagation()"
            />
          }
          <div class="sel__list">
            @for (o of filtered(); track o.value) {
              <button
                type="button"
                class="sel__opt"
                [class.sel__opt--on]="o.value === value()"
                (click)="pick(o.value)"
              >
                @if (o.color) {
                  <span class="sel__dot" [style.background]="o.color"></span>
                }
                <span class="sel__opt-main">
                  <span class="sel__opt-label">{{ o.label }}</span>
                  @if (o.sub) {
                    <span class="sel__opt-sub">{{ o.sub }}</span>
                  }
                </span>
                @if (o.value === value()) {
                  <span class="sel__check">✓</span>
                }
              </button>
            }
            @if (!filtered().length) {
              <div class="sel__empty">Ничего не найдено</div>
            }
          </div>
        </div>
      }
    </div>
  `,
  styles: [
    `
      .sel {
        display: block;
        position: relative;
        min-width: 0;
      }
      .sel--open {
        z-index: 80;
      }
      .sel__btn {
        display: flex;
        align-items: center;
        gap: 8px;
        width: 100%;
        padding: 8px 10px;
        border-radius: 9px;
        border: 1px solid var(--border-strong);
        background: var(--surface-2);
        color: var(--text);
        font-size: 13px;
        text-align: left;
        transition: border-color 0.15s ease, box-shadow 0.15s ease;
      }
      .sel__btn:hover {
        border-color: var(--accent);
      }
      .sel--open .sel__btn {
        border-color: var(--accent);
        box-shadow: 0 0 0 3px var(--accent-soft);
      }
      .sel__btn--pending {
        border-color: var(--err);
        box-shadow: 0 0 0 2px color-mix(in srgb, var(--err) 22%, transparent);
      }
      .sel__value {
        flex: 1;
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .sel__value--ph {
        color: var(--text-muted);
      }
      .sel__caret {
        color: var(--text-muted);
        font-size: 11px;
        transition: transform 0.15s ease;
      }
      .sel--open .sel__caret {
        transform: rotate(180deg);
      }
      .sel__dot {
        width: 10px;
        height: 10px;
        border-radius: 3px;
        flex-shrink: 0;
      }
      .sel__menu {
        position: absolute;
        z-index: 90;
        top: calc(100% + 5px);
        left: 0;
        min-width: 100%;
        max-width: min(360px, 90vw);
        background: var(--surface);
        border: 1px solid var(--border-strong);
        border-radius: 11px;
        box-shadow: var(--shadow);
        padding: 5px;
        animation: sel-in 0.13s ease;
      }
      @keyframes sel-in {
        from {
          opacity: 0;
          transform: translateY(-4px);
        }
      }
      .sel__search {
        width: 100%;
        padding: 7px 9px;
        margin-bottom: 5px;
        border-radius: 8px;
        border: 1px solid var(--border-strong);
        background: var(--surface-2);
        color: var(--text);
        font-size: 12.5px;
        outline: none;
      }
      .sel__search:focus {
        border-color: var(--accent);
      }
      .sel__list {
        max-height: 280px;
        overflow-y: auto;
        display: flex;
        flex-direction: column;
        gap: 1px;
      }
      .sel__opt {
        display: flex;
        align-items: center;
        gap: 8px;
        width: 100%;
        padding: 7px 9px;
        border: none;
        border-radius: 8px;
        background: transparent;
        color: var(--text);
        font-size: 13px;
        text-align: left;
        transition: background 0.1s ease;
      }
      .sel__opt:hover {
        background: var(--chip-bg);
      }
      .sel__opt--on {
        background: var(--accent-soft);
      }
      .sel__opt-main {
        flex: 1;
        min-width: 0;
        display: flex;
        flex-direction: column;
      }
      .sel__opt-label {
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .sel__opt-sub {
        font-size: 11px;
        color: var(--text-muted);
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .sel__check {
        color: var(--accent);
        font-weight: 700;
        flex-shrink: 0;
      }
      .sel__empty {
        padding: 14px;
        text-align: center;
        color: var(--text-muted);
        font-size: 12.5px;
      }
    `,
  ],
})
export class SelectComponent {
  readonly options = input<SelectOption[]>([]);
  readonly value = input<string>('');
  readonly placeholder = input<string>('—');
  readonly searchable = input<boolean>(false);
  readonly searchPlaceholder = input<string>('Поиск…');
  readonly width = input<string>('');
  readonly pending = input<boolean>(false);
  /** Render the menu with position:fixed so it escapes clipping/scroll ancestors. */
  readonly fixed = input<boolean>(false);
  readonly valueChange = output<string>();

  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  readonly open = signal(false);
  readonly query = signal('');
  readonly menuPos = signal<{ top: number; left: number; width: number }>({ top: 0, left: 0, width: 0 });

  private readonly current = computed(() => this.options().find((o) => o.value === this.value()));
  readonly hasValue = computed(() => !!this.value() && !!this.current());
  readonly currentLabel = computed(() => this.current()?.label ?? this.placeholder());
  readonly currentColor = computed(() => this.current()?.color ?? null);

  readonly filtered = computed(() => {
    const q = this.query().trim().toLowerCase();
    if (!q) return this.options();
    return this.options().filter(
      (o) => o.label.toLowerCase().includes(q) || (o.sub ?? '').toLowerCase().includes(q),
    );
  });

  toggle(): void {
    const willOpen = !this.open();
    this.open.set(willOpen);
    if (willOpen) {
      this.query.set('');
      if (this.fixed()) this.measure();
    }
  }
  pick(v: string): void {
    this.valueChange.emit(v);
    this.open.set(false);
  }

  /** Position a fixed menu just below (or above) the trigger button. */
  private measure(): void {
    const btn = this.host.nativeElement.querySelector('.sel__btn') as HTMLElement | null;
    if (!btn) return;
    const r = btn.getBoundingClientRect();
    const estH = Math.min(320, 56 + this.filtered().length * 34);
    const below = window.innerHeight - r.bottom;
    const top = below < estH && r.top > below ? Math.max(8, r.top - estH - 6) : r.bottom + 5;
    this.menuPos.set({ top, left: r.left, width: r.width });
  }

  @HostListener('document:mousedown', ['$event'])
  onDocDown(ev: MouseEvent): void {
    if (this.open() && !this.host.nativeElement.contains(ev.target as Node)) this.open.set(false);
  }
  // Scrolling/wheeling outside the menu would leave a fixed menu detached — close it.
  @HostListener('document:wheel', ['$event'])
  onWheel(ev: WheelEvent): void {
    if (this.open() && this.fixed() && !this.host.nativeElement.contains(ev.target as Node)) {
      this.open.set(false);
    }
  }
  @HostListener('window:resize')
  onWinResize(): void {
    if (this.open() && this.fixed()) this.open.set(false);
  }
  @HostListener('document:keydown.escape')
  onEsc(): void {
    if (this.open()) this.open.set(false);
  }
}
