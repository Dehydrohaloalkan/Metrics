import { Chart, Plugin } from 'chart.js';

/**
 * Drag-to-select a time range on a category-axis line chart. When the user
 * drags horizontally across the plot, a translucent band is drawn and, on
 * release, `onSelect(loIndex, hiIndex)` fires with the covered category indices.
 * A plain click (drag below the threshold) is left untouched so the existing
 * click-to-filter-bucket behaviour keeps working.
 *
 * Enable per-chart via `options.plugins.timeBrush = { onSelect }`.
 */
export interface TimeBrushOptions {
  onSelect: (loIndex: number, hiIndex: number) => void;
}

interface BrushState {
  down: boolean;
  dragging: boolean;
  suppressClick: boolean;
  startX: number | null;
  curX: number | null;
  handlers?: {
    onDown: (e: MouseEvent) => void;
    onMove: (e: MouseEvent) => void;
    onUp: () => void;
    onClickCapture: (e: MouseEvent) => void;
  };
}

const DRAG_THRESHOLD = 4; // px of movement before it counts as a brush, not a click

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const stateOf = (chart: Chart): BrushState => (chart as any).$timeBrush;

export const timeBrushPlugin: Plugin = {
  id: 'timeBrush',

  afterInit(chart) {
    const canvas = chart.canvas;
    if (!canvas) return;
    const state: BrushState = {
      down: false,
      dragging: false,
      suppressClick: false,
      startX: null,
      curX: null,
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (chart as any).$timeBrush = state;

    const getOpts = (): TimeBrushOptions | null =>
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ((chart.options?.plugins as any)?.timeBrush as TimeBrushOptions) ?? null;

    const pos = (e: MouseEvent) => {
      const r = canvas.getBoundingClientRect();
      return { x: e.clientX - r.left, y: e.clientY - r.top };
    };
    const inArea = (x: number, y: number) => {
      const a = chart.chartArea;
      return !!a && x >= a.left && x <= a.right && y >= a.top && y <= a.bottom;
    };

    const onDown = (e: MouseEvent) => {
      if (!getOpts() || e.button !== 0) return;
      const { x, y } = pos(e);
      if (!inArea(x, y)) return;
      state.down = true;
      state.dragging = false;
      state.startX = x;
      state.curX = x;
    };
    const onMove = (e: MouseEvent) => {
      if (!state.down) return;
      const a = chart.chartArea;
      const { x } = pos(e);
      state.curX = Math.max(a.left, Math.min(a.right, x));
      if (!state.dragging && Math.abs((state.curX ?? 0) - (state.startX ?? 0)) > DRAG_THRESHOLD) {
        state.dragging = true;
      }
      if (state.dragging) chart.draw();
    };
    const onUp = () => {
      if (!state.down) return;
      state.down = false;
      const opts = getOpts();
      if (state.dragging && opts && state.startX != null && state.curX != null) {
        const xScale = chart.scales['x'];
        const n = chart.data.labels?.length ?? 0;
        const a = (px: number) =>
          Math.max(0, Math.min(n - 1, Math.round(xScale.getValueForPixel(px) as number)));
        const lo = a(Math.min(state.startX, state.curX));
        const hi = a(Math.max(state.startX, state.curX));
        if (n > 0 && hi >= lo) {
          state.suppressClick = true; // swallow the click that follows the drag
          opts.onSelect(lo, hi);
        }
      }
      state.dragging = false;
      state.startX = null;
      state.curX = null;
      chart.draw();
    };
    const onClickCapture = (e: MouseEvent) => {
      if (state.suppressClick) {
        state.suppressClick = false;
        e.stopImmediatePropagation();
        e.preventDefault();
      }
    };

    canvas.addEventListener('mousedown', onDown);
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    canvas.addEventListener('click', onClickCapture, true);
    state.handlers = { onDown, onMove, onUp, onClickCapture };
  },

  afterDraw(chart) {
    const state = stateOf(chart);
    if (!state?.dragging || state.startX == null || state.curX == null) return;
    const a = chart.chartArea;
    const ctx = chart.ctx;
    const x1 = Math.min(state.startX, state.curX);
    const x2 = Math.max(state.startX, state.curX);
    ctx.save();
    ctx.fillStyle = 'rgba(99, 102, 241, 0.18)';
    ctx.strokeStyle = 'rgba(99, 102, 241, 0.85)';
    ctx.lineWidth = 1;
    ctx.fillRect(x1, a.top, x2 - x1, a.bottom - a.top);
    ctx.beginPath();
    ctx.moveTo(x1 + 0.5, a.top);
    ctx.lineTo(x1 + 0.5, a.bottom);
    ctx.moveTo(x2 - 0.5, a.top);
    ctx.lineTo(x2 - 0.5, a.bottom);
    ctx.stroke();
    ctx.restore();
  },

  beforeDestroy(chart) {
    const state = stateOf(chart);
    const canvas = chart.canvas;
    if (state?.handlers) {
      canvas?.removeEventListener('mousedown', state.handlers.onDown);
      window.removeEventListener('mousemove', state.handlers.onMove);
      window.removeEventListener('mouseup', state.handlers.onUp);
      canvas?.removeEventListener('click', state.handlers.onClickCapture, true);
    }
  },
};
