// Frame and update-handler timing for perfDiagService; no natives here, so a node harness can drive it

export const PERF_REPORT_MS = 30000;
export const PERF_TOP_HANDLERS = 6;
export const LATE_LABEL = "late";

type Slot = { label: string, ms: number, calls: number };
type Handler = (...args: any[]) => any;

export function perfDiagEnabled(settings: Record<string, unknown> | undefined): boolean {
  return !settings || settings["perfDiag"] !== false;
}

// Frame count, worst interval and slow frames since the last take
export class FrameWindow {
  frame(now: number): void {
    if (this.last) {
      const dt = now - this.last;
      if (dt > this.worst) this.worst = dt;
      if (dt > 50) this.over50++;
      if (dt > 100) this.over100++;
    } else {
      this.start = now;
    }
    this.last = now;
    this.frames++;
  }

  take(now: number): { fps: number, frames: number, windowMs: number, worstMs: number, over50: number, over100: number } | null {
    const windowMs = now - this.start;
    if (!this.last || windowMs <= 0) return null;
    const out = {
      fps: Math.round(((this.frames - 1) * 10000) / windowMs) / 10, frames: this.frames, windowMs,
      worstMs: this.worst, over50: this.over50, over100: this.over100,
    };
    this.start = now;
    this.frames = 1;
    this.worst = this.over50 = this.over100 = 0;
    return out;
  }

  private start = 0;
  private last = 0;
  private frames = 0;
  private worst = 0;
  private over50 = 0;
  private over100 = 0;
}

export function topSlots(slots: Slot[], n: number): Array<[string, number, number]> {
  return slots.filter((s) => s.ms > 0).sort((a, b) => b.ms - a.ms).slice(0, n).map((s) => [s.label, s.ms, s.calls]);
}

// Date.now() is whole milliseconds; summed over a window the rounding averages out
export class UpdateTiming {
  setLabel(label: string): void {
    this.label = label;
  }

  wrap(handler: Handler): Handler {
    let slot = this.slots.get(this.label);
    if (!slot) {
      slot = { label: this.label, ms: 0, calls: 0 };
      this.slots.set(this.label, slot);
    }
    const s = slot;
    // arguments, not a rest parameter: es5 would copy it into a new array every call
    return function (this: unknown) {
      const t0 = Date.now();
      try {
        return handler.apply(this, arguments as any);
      } finally {
        s.ms += Date.now() - t0;
        s.calls++;
      }
    };
  }

  take(n: number): { jsMs: number, top: Array<[string, number, number]> } {
    const all = Array.from(this.slots.values());
    let jsMs = 0;
    for (const s of all) jsMs += s.ms;
    const top = topSlots(all, n);
    for (const s of all) { s.ms = 0; s.calls = 0; }
    return { jsMs, top };
  }

  private label = LATE_LABEL;
  private slots = new Map<string, Slot>();
}

export const updateTiming = new UpdateTiming();
