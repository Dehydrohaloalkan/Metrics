import { Component, input, computed, ChangeDetectionStrategy } from '@angular/core';

/** Tiny inline SVG sparkline (area + line) for KPI cards. */
@Component({
  selector: 'app-sparkline',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (path()) {
      <svg viewBox="0 0 100 30" preserveAspectRatio="none" class="spark">
        <path [attr.d]="area()" [attr.fill]="color()" fill-opacity="0.14" stroke="none" />
        <path [attr.d]="path()" fill="none" [attr.stroke]="color()" stroke-width="2"
              stroke-linejoin="round" stroke-linecap="round" vector-effect="non-scaling-stroke" />
      </svg>
    }
  `,
  styles: [
    `
      :host {
        display: block;
        width: 100%;
        height: 30px;
      }
      .spark {
        width: 100%;
        height: 100%;
        display: block;
      }
    `,
  ],
})
export class SparklineComponent {
  readonly points = input<number[]>([]);
  readonly color = input<string>('#6366f1');

  readonly path = computed(() => this.build().line);
  readonly area = computed(() => this.build().area);

  private build(): { line: string; area: string } {
    const pts = this.points();
    if (pts.length < 2) return { line: '', area: '' };
    const max = Math.max(...pts, 1);
    const min = Math.min(...pts, 0);
    const span = max - min || 1;
    const n = pts.length - 1;
    const coords = pts.map((v, i) => {
      const x = (i / n) * 100;
      const y = 28 - ((v - min) / span) * 26 - 1;
      return [x, y] as const;
    });
    const line = coords.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(2)} ${y.toFixed(2)}`).join(' ');
    const area = `${line} L100 30 L0 30 Z`;
    return { line, area };
  }
}
