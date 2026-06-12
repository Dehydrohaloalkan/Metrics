import {
  Component,
  input,
  signal,
  computed,
  effect,
  untracked,
  OnDestroy,
  ChangeDetectionStrategy,
} from '@angular/core';

/** Animated number that counts up/down to its value. */
@Component({
  selector: 'app-count',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `{{ display() }}`,
})
export class CountComponent implements OnDestroy {
  readonly value = input<number>(0);
  readonly kind = input<'int' | 'pct'>('int');

  private readonly current = signal(0);
  private raf = 0;

  readonly display = computed(() => {
    const v = this.current();
    if (this.kind() === 'pct') return (Math.round(v * 10) / 10).toFixed(1) + '%';
    return new Intl.NumberFormat('ru-RU').format(Math.round(v));
  });

  constructor() {
    effect(() => {
      const target = this.value();
      const start = untracked(() => this.current());
      this.run(start, target);
    });
  }

  private run(from: number, to: number): void {
    cancelAnimationFrame(this.raf);
    if (!isFinite(to)) {
      this.current.set(0);
      return;
    }
    const dur = 600;
    const t0 = performance.now();
    const tick = (now: number) => {
      const p = Math.min(1, (now - t0) / dur);
      const eased = 1 - Math.pow(1 - p, 3);
      this.current.set(from + (to - from) * eased);
      if (p < 1) this.raf = requestAnimationFrame(tick);
      else this.current.set(to);
    };
    this.raf = requestAnimationFrame(tick);
  }

  ngOnDestroy(): void {
    cancelAnimationFrame(this.raf);
  }
}
