import {
  Component,
  ElementRef,
  AfterViewInit,
  OnDestroy,
  effect,
  input,
  viewChild,
  ChangeDetectionStrategy,
} from '@angular/core';

export interface GraphNode {
  id: string;
  label: string;
  kind: 'source' | 'endpoint';
  count: number;
  color: string;
}
export interface GraphLink {
  source: string;
  target: string;
  value: number;
}
export interface GraphData {
  nodes: GraphNode[];
  links: GraphLink[];
}
export interface CloudPalette {
  text: string;
  textMuted: string;
  grid: string;
  surface: string;
}

interface Sim {
  id: string;
  label: string;
  kind: 'source' | 'endpoint';
  color: string;
  count: number;
  r: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
}

/**
 * Lightweight force-directed graph drawn on a canvas (no external deps).
 * Sources are colored by their group; endpoints are cyan. Node size encodes
 * request volume; edges encode how much a source hits an endpoint.
 */
@Component({
  selector: 'app-cloud',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="cloud" [style.height.px]="height()">
      <canvas #canvas (mousemove)="onMove($event)" (mouseleave)="hover = null"></canvas>
      @if (hover; as h) {
        <div class="cloud__tip" [style.left.px]="tipX" [style.top.px]="tipY">
          <b>{{ h.label }}</b>
          <span>{{ h.kind === 'source' ? 'источник' : 'эндпоинт' }} · {{ fmt(h.count) }}</span>
        </div>
      }
      <div class="cloud__legend">
        <span><i style="background:#22d3ee"></i> эндпоинт</span>
        <span><i style="background:#8b98a9"></i> источник (цвет = группа)</span>
      </div>
    </div>
  `,
  styles: [
    `
      .cloud {
        position: relative;
        width: 100%;
      }
      canvas {
        width: 100%;
        height: 100%;
        display: block;
        cursor: grab;
      }
      .cloud__tip {
        position: absolute;
        z-index: 5;
        transform: translate(-50%, -130%);
        background: var(--surface);
        border: 1px solid var(--border-strong);
        border-radius: 8px;
        padding: 6px 10px;
        font-size: 12px;
        pointer-events: none;
        box-shadow: var(--shadow);
        white-space: nowrap;
        display: flex;
        flex-direction: column;
        gap: 2px;
      }
      .cloud__tip span {
        color: var(--text-muted);
        font-size: 11px;
      }
      .cloud__legend {
        position: absolute;
        left: 10px;
        bottom: 8px;
        display: flex;
        gap: 14px;
        font-size: 11px;
        color: var(--text-muted);
        pointer-events: none;
      }
      .cloud__legend span {
        display: inline-flex;
        align-items: center;
        gap: 5px;
      }
      .cloud__legend i {
        width: 9px;
        height: 9px;
        border-radius: 50%;
        display: inline-block;
      }
    `,
  ],
})
export class CloudComponent implements AfterViewInit, OnDestroy {
  readonly data = input.required<GraphData>();
  readonly palette = input.required<CloudPalette>();
  readonly height = input<number>(420);

  private readonly canvasRef = viewChild.required<ElementRef<HTMLCanvasElement>>('canvas');
  private nodes: Sim[] = [];
  private byId = new Map<string, Sim>();
  private raf = 0;
  private ro?: ResizeObserver;
  private alpha = 1;
  private w = 0;
  private h = 0;
  private ready = false;

  hover: Sim | null = null;
  tipX = 0;
  tipY = 0;

  constructor() {
    effect(() => {
      const d = this.data();
      this.palette(); // re-render on theme change
      if (this.ready) this.build(d);
    });
  }

  ngAfterViewInit(): void {
    const canvas = this.canvasRef().nativeElement;
    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(canvas);
    this.ready = true;
    this.resize();
    this.build(this.data());
  }

  ngOnDestroy(): void {
    cancelAnimationFrame(this.raf);
    this.ro?.disconnect();
  }

  fmt(n: number): string {
    return new Intl.NumberFormat('ru-RU').format(n);
  }

  onMove(ev: MouseEvent): void {
    const rect = this.canvasRef().nativeElement.getBoundingClientRect();
    const x = ev.clientX - rect.left;
    const y = ev.clientY - rect.top;
    let best: Sim | null = null;
    let bestD = Infinity;
    for (const n of this.nodes) {
      const dx = n.x - x;
      const dy = n.y - y;
      const d = dx * dx + dy * dy;
      if (d < (n.r + 4) * (n.r + 4) && d < bestD) {
        bestD = d;
        best = n;
      }
    }
    this.hover = best;
    if (best) {
      this.tipX = best.x;
      this.tipY = best.y - best.r;
    }
  }

  private resize(): void {
    const canvas = this.canvasRef().nativeElement;
    const dpr = window.devicePixelRatio || 1;
    this.w = canvas.clientWidth || 600;
    this.h = canvas.clientHeight || this.height();
    canvas.width = Math.round(this.w * dpr);
    canvas.height = Math.round(this.h * dpr);
    const ctx = canvas.getContext('2d');
    if (ctx) ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.alpha = 1; // reheat the simulation so it settles into the new box
  }

  private build(d: GraphData): void {
    const prev = this.byId;
    const counts = d.nodes.map((n) => n.count);
    const max = Math.max(1, ...counts);
    const min = Math.min(...counts, 0);
    const scale = (c: number) => 7 + 26 * Math.sqrt((c - min) / (max - min || 1));

    this.nodes = d.nodes.map((n) => {
      const old = prev.get(n.id);
      return {
        id: n.id,
        label: n.label,
        kind: n.kind,
        color: n.color,
        count: n.count,
        r: scale(n.count),
        x: old?.x ?? this.w / 2 + (Math.random() - 0.5) * 200,
        y: old?.y ?? this.h / 2 + (Math.random() - 0.5) * 200,
        vx: 0,
        vy: 0,
      };
    });
    this.byId = new Map(this.nodes.map((n) => [n.id, n]));
    this.links = d.links
      .map((l) => ({ a: this.byId.get(l.source), b: this.byId.get(l.target), v: l.value }))
      .filter((l): l is { a: Sim; b: Sim; v: number } => !!l.a && !!l.b);
    this.maxLink = Math.max(1, ...this.links.map((l) => l.v));

    this.alpha = 1;
    if (!this.raf) this.tick();
  }

  private links: { a: Sim; b: Sim; v: number }[] = [];
  private maxLink = 1;

  private tick = (): void => {
    this.step();
    this.draw();
    this.alpha *= 0.985;
    if (this.alpha > 0.02) {
      this.raf = requestAnimationFrame(this.tick);
    } else {
      this.raf = 0;
      this.draw();
    }
  };

  private step(): void {
    const cx = this.w / 2;
    const cy = this.h / 2;
    const a = this.alpha;

    // gravity toward center
    for (const n of this.nodes) {
      n.vx += (cx - n.x) * 0.0012 * a;
      n.vy += (cy - n.y) * 0.0012 * a;
    }
    // repulsion between every pair
    for (let i = 0; i < this.nodes.length; i++) {
      const p = this.nodes[i];
      for (let j = i + 1; j < this.nodes.length; j++) {
        const q = this.nodes[j];
        let dx = p.x - q.x;
        let dy = p.y - q.y;
        let dist2 = dx * dx + dy * dy;
        if (dist2 < 0.01) {
          dx = Math.random() - 0.5;
          dy = Math.random() - 0.5;
          dist2 = 0.01;
        }
        const minDist = p.r + q.r + 14;
        const dist = Math.sqrt(dist2);
        const force = ((p.r + q.r) * 26 * a) / dist2;
        const fx = (dx / dist) * force;
        const fy = (dy / dist) * force;
        p.vx += fx;
        p.vy += fy;
        q.vx -= fx;
        q.vy -= fy;
        // hard collision so circles never overlap
        if (dist < minDist) {
          const push = (minDist - dist) / 2;
          p.x += (dx / dist) * push;
          p.y += (dy / dist) * push;
          q.x -= (dx / dist) * push;
          q.y -= (dy / dist) * push;
        }
      }
    }
    // spring along links
    for (const l of this.links) {
      const dx = l.b.x - l.a.x;
      const dy = l.b.y - l.a.y;
      const dist = Math.sqrt(dx * dx + dy * dy) || 1;
      const target = l.a.r + l.b.r + 60;
      const k = 0.02 * a * (0.4 + 0.6 * (l.v / this.maxLink));
      const f = (dist - target) * k;
      const fx = (dx / dist) * f;
      const fy = (dy / dist) * f;
      l.a.vx += fx;
      l.a.vy += fy;
      l.b.vx -= fx;
      l.b.vy -= fy;
    }
    // integrate with damping + keep inside the box
    for (const n of this.nodes) {
      n.x += n.vx *= 0.82;
      n.y += n.vy *= 0.82;
      n.x = Math.max(n.r + 2, Math.min(this.w - n.r - 2, n.x));
      n.y = Math.max(n.r + 2, Math.min(this.h - n.r - 2, n.y));
    }
  }

  private draw(): void {
    const ctx = this.canvasRef().nativeElement.getContext('2d');
    if (!ctx) return;
    const p = this.palette();
    ctx.clearRect(0, 0, this.w, this.h);

    // edges
    for (const l of this.links) {
      const on = this.hover && (this.hover === l.a || this.hover === l.b);
      ctx.strokeStyle = on ? p.text : p.grid;
      ctx.globalAlpha = on ? 0.7 : 0.5;
      ctx.lineWidth = on ? 1.6 : 0.5 + 2 * (l.v / this.maxLink);
      ctx.beginPath();
      ctx.moveTo(l.a.x, l.a.y);
      ctx.lineTo(l.b.x, l.b.y);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;

    // nodes
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (const n of this.nodes) {
      const dim = this.hover && this.hover !== n && !this.isNeighbor(n);
      ctx.globalAlpha = dim ? 0.35 : 1;
      ctx.beginPath();
      ctx.arc(n.x, n.y, n.r, 0, Math.PI * 2);
      ctx.fillStyle = n.color;
      ctx.fill();
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = p.surface;
      ctx.stroke();
      // label for bigger nodes (or the hovered one)
      if (n.r >= 15 || this.hover === n) {
        const label = n.label.length > 16 ? n.label.slice(0, 15) + '…' : n.label;
        ctx.font = '600 11px "Segoe UI", system-ui, sans-serif';
        ctx.fillStyle = p.text;
        ctx.fillText(label, n.x, n.y + n.r + 9);
      }
    }
    ctx.globalAlpha = 1;
  }

  private isNeighbor(n: Sim): boolean {
    if (!this.hover) return false;
    for (const l of this.links) {
      if ((l.a === this.hover && l.b === n) || (l.b === this.hover && l.a === n)) return true;
    }
    return false;
  }
}
