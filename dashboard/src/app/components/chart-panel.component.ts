import {
  Component,
  ElementRef,
  effect,
  input,
  output,
  viewChild,
  AfterViewInit,
  OnDestroy,
  ChangeDetectionStrategy,
} from '@angular/core';
import { Chart, ChartConfiguration, registerables } from 'chart.js';

Chart.register(...registerables);

@Component({
  selector: 'app-chart-panel',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section class="panel">
      <header class="panel__head">
        <div>
          <h3>{{ title() }}</h3>
          @if (subtitle()) {
            <p>{{ subtitle() }}</p>
          }
        </div>
        <div class="panel__tools">
          <ng-content select="[panelActions]"></ng-content>
          @if (expandable()) {
            <button class="panel__fs" (click)="expand.emit()" title="На весь экран">⛶</button>
          }
        </div>
      </header>
      <div
        class="panel__body"
        [style.maxHeight.px]="bodyMaxHeight() || null"
        [style.overflowY]="bodyMaxHeight() ? 'auto' : 'visible'"
      >
        @if (empty()) {
          <div class="panel__empty" [style.height.px]="height()">Нет данных для отображения</div>
        }
        <div class="panel__canvas" [style.height.px]="height()" [style.display]="empty() ? 'none' : 'block'">
          <canvas #canvas></canvas>
        </div>
      </div>
    </section>
  `,
  styles: [
    `
      .panel {
        background: var(--surface);
        border: 1px solid var(--border);
        border-radius: 16px;
        padding: 18px 18px 14px;
        box-shadow: var(--shadow);
        display: flex;
        flex-direction: column;
        min-width: 0;
      }
      .panel__head {
        display: flex;
        align-items: flex-start;
        justify-content: space-between;
        gap: 12px;
        margin-bottom: 10px;
      }
      .panel__head h3 {
        margin: 0;
        font-size: 14px;
        font-weight: 650;
        letter-spacing: 0.2px;
        color: var(--text);
      }
      .panel__tools {
        display: flex;
        align-items: center;
        gap: 8px;
        flex-wrap: wrap;
        justify-content: flex-end;
      }
      .panel__fs {
        border: 1px solid var(--border-strong);
        background: var(--surface-2);
        color: var(--text-muted);
        border-radius: 8px;
        width: 28px;
        height: 26px;
        font-size: 14px;
        line-height: 1;
        display: inline-grid;
        place-items: center;
      }
      .panel__fs:hover {
        color: var(--text);
        border-color: var(--accent);
      }
      .panel__head p {
        margin: 2px 0 0;
        font-size: 12px;
        color: var(--text-muted);
      }
      .panel__body {
        position: relative;
        width: 100%;
      }
      .panel__canvas {
        position: relative;
        width: 100%;
      }
      .panel__empty {
        position: absolute;
        inset: 0;
        display: grid;
        place-items: center;
        color: var(--text-muted);
        font-size: 13px;
      }
    `,
  ],
})
export class ChartPanelComponent implements AfterViewInit, OnDestroy {
  readonly title = input<string>('');
  readonly subtitle = input<string>('');
  readonly height = input<number>(260);
  readonly bodyMaxHeight = input<number>(0);
  readonly config = input.required<ChartConfiguration<any>>();
  readonly empty = input<boolean>(false);
  readonly expandable = input<boolean>(false);
  readonly expand = output<void>();

  private readonly canvasRef = viewChild.required<ElementRef<HTMLCanvasElement>>('canvas');
  private chart: Chart | null = null;
  private ready = false;

  constructor() {
    effect(() => {
      const cfg = this.config();
      if (this.ready) this.render(cfg);
    });
  }

  ngAfterViewInit(): void {
    this.ready = true;
    this.render(this.config());
  }

  ngOnDestroy(): void {
    this.chart?.destroy();
  }

  private render(cfg: ChartConfiguration<any>): void {
    if (this.empty()) {
      this.chart?.destroy();
      this.chart = null;
      return;
    }
    try {
      // Update in place when possible — recreating the chart on every filter /
      // theme / search change leaks animation buffers and eventually makes the
      // canvases go blank. Only rebuild when the chart type actually changes.
      if (this.chart && (this.chart.config as { type?: string }).type === cfg.type) {
        this.chart.data = cfg.data;
        this.chart.options = cfg.options ?? {};
        this.chart.update('none');
      } else {
        this.chart?.destroy();
        this.chart = new Chart(this.canvasRef().nativeElement, cfg);
      }
    } catch {
      // If an update ever throws, drop the instance and rebuild from scratch
      // so a single bad frame can't permanently break the panel.
      try {
        this.chart?.destroy();
      } catch {
        /* ignore */
      }
      this.chart = new Chart(this.canvasRef().nativeElement, cfg);
    }
  }
}
