import { Component, input, computed, ChangeDetectionStrategy } from '@angular/core';
import { Heatmap } from '../services/data.service';

@Component({
  selector: 'app-heatmap',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (data().grandTotal === 0) {
      <div class="hm__empty">Нет данных с распознанным временем</div>
    } @else {
      <div class="hm__scroll">
        <div
          class="hm__grid"
          [style.gridTemplateColumns]="'40px repeat(' + data().cols + ', minmax(' + cellMin() + 'px, 1fr))'"
        >
          <div class="hm__corner"></div>
          @for (lbl of data().colLabels; track $index) {
            <div class="hm__colh">{{ lbl }}</div>
          }

          @for (row of data().rows; track row.day) {
            <div class="hm__rowh" [title]="row.label + ': ' + fmt(row.total)">{{ row.label }}</div>
            @for (c of row.cells; track $index) {
              <div
                class="hm__cell"
                [class.hm__cell--zero]="c === 0"
                [style.background]="color(c)"
                [title]="cellTitle(row.label, $index, c)"
              ></div>
            }
          }
        </div>
      </div>

      <div class="hm__footer">
        <span class="hm__axis">часы суток (0–23)</span>
        <div class="hm__legend">
          <span>меньше</span>
          <span class="hm__grad"></span>
          <span>больше · max {{ fmt(data().max) }}</span>
        </div>
      </div>
    }
  `,
  styles: [
    `
      :host {
        display: block;
      }
      .hm__scroll {
        overflow-x: auto;
        padding-bottom: 6px;
      }
      .hm__grid {
        display: grid;
        gap: 3px;
        align-items: center;
        min-width: 100%;
      }
      .hm__corner {
        height: 18px;
      }
      .hm__colh {
        font-size: 10.5px;
        color: var(--text-muted);
        text-align: left;
        white-space: nowrap;
        height: 18px;
        line-height: 18px;
      }
      .hm__rowh {
        font-size: 11.5px;
        font-weight: 600;
        color: var(--text-muted);
        padding-right: 4px;
      }
      .hm__cell {
        height: 26px;
        border-radius: 5px;
        cursor: default;
        transition: outline 0.08s ease;
      }
      .hm__cell:hover {
        outline: 2px solid var(--accent);
        outline-offset: -1px;
      }
      .hm__cell--zero {
        background: var(--chip-bg) !important;
      }
      .hm__footer {
        display: flex;
        align-items: center;
        justify-content: space-between;
        margin-top: 10px;
        gap: 12px;
      }
      .hm__axis {
        font-size: 12px;
        color: var(--text-muted);
      }
      .hm__legend {
        display: flex;
        align-items: center;
        gap: 8px;
        font-size: 11.5px;
        color: var(--text-muted);
      }
      .hm__grad {
        width: 140px;
        height: 10px;
        border-radius: 999px;
        background: linear-gradient(
          90deg,
          rgb(59, 76, 202),
          rgb(34, 211, 238),
          rgb(52, 211, 153),
          rgb(251, 191, 36),
          rgb(251, 113, 133)
        );
      }
      .hm__empty {
        height: 120px;
        display: grid;
        place-items: center;
        color: var(--text-muted);
        font-size: 13px;
      }
    `,
  ],
})
export class HeatmapComponent {
  readonly data = input.required<Heatmap>();

  readonly cellMin = computed(() => (this.data().cols > 48 ? 13 : this.data().cols > 24 ? 16 : 22));

  // indigo -> cyan -> green -> amber -> rose: strong contrast even for
  // values that are close together.
  private readonly stops = [
    [59, 76, 202],
    [34, 211, 238],
    [52, 211, 153],
    [251, 191, 36],
    [251, 113, 133],
  ];

  color(count: number): string {
    if (!count) return 'var(--chip-bg)';
    const { min, max } = this.data();
    // Stretch the actual value range so similar counts still differ visibly.
    const t = max > min ? (count - min) / (max - min) : 1;
    return this.colorScale(t);
  }

  private colorScale(t: number): string {
    const x = Math.max(0, Math.min(1, t)) * (this.stops.length - 1);
    const i = Math.floor(x);
    const f = x - i;
    const a = this.stops[i];
    const b = this.stops[Math.min(i + 1, this.stops.length - 1)];
    const c = a.map((av, k) => Math.round(av + (b[k] - av) * f));
    return `rgb(${c[0]}, ${c[1]}, ${c[2]})`;
  }

  cellTitle(day: string, colIdx: number, count: number): string {
    const bm = this.data().bucketMin;
    const start = colIdx * bm;
    const end = start + bm;
    return `${day} ${this.hhmm(start)}–${this.hhmm(end)}: ${this.fmt(count)} запр.`;
  }

  fmt(n: number): string {
    return n.toLocaleString('ru-RU');
  }

  private hhmm(min: number): string {
    const m = min % 1440;
    const p = (x: number) => String(x).padStart(2, '0');
    return `${p(Math.floor(m / 60))}:${p(m % 60)}`;
  }
}
