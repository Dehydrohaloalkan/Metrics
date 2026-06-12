import {
  Component,
  ElementRef,
  effect,
  input,
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
        <ng-content select="[panelActions]"></ng-content>
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
    // Recreate to cleanly pick up theme/type changes.
    this.chart?.destroy();
    this.chart = new Chart(this.canvasRef().nativeElement, cfg);
  }
}
