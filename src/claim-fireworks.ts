/**
 * Fireworks celebration for successful ZCode claims.
 *
 * This deliberately uses an editor widget rather than `ui.custom`: OMP's
 * custom UI calls `TUI.showOverlay()`, which always moves keyboard focus to the
 * component. A decorative celebration must never intercept Escape, Ctrl-C, or
 * text intended for the editor.
 */

/** Seconds→tick pacing for the animation loop (frames per second). */
const FPS = 12;
/** Burst glyphs, brightest first — pure ANSI text, no theme dependency. */
const BURST_GLYPHS = ["✦", "✧", "✶", "✷", "*"];
const FIREWORKS_WIDGET_KEY = "zcode-claim-fireworks";
const DEFAULT_DURATION_MS = 12_000;

export interface ClaimFireworksTui {
  requestRender(): void;
}

export interface ClaimFireworksMessage {
  /** Large grant total, e.g. `100,000,000 TOKENS`. */
  headline: string;
  /** Plan, entitlement, validity, and account lines. */
  lines: readonly string[];
}

export interface FireworksComponent {
  render(width: number): readonly string[];
  invalidate?(): void;
}

type FireworksWidgetContent =
  | string[]
  | ((tui: ClaimFireworksTui, theme: unknown) => FireworksComponent)
  | undefined;
/**
 * Minimal host surface: the slice of OMP's `ExtensionContext` we consume.
 *
 * The timers come from the context rather than globals on purpose - OMP clears
 * context timers on `session_shutdown`, so a celebration can never fire a
 * callback into a session that no longer exists.
 */
export interface ClaimFireworksHost {
  mode: string;
  hasUI: boolean;
  ui: {
    setWidget(
      key: string,
      content: FireworksWidgetContent,
      options?: { placement?: "aboveEditor" | "belowEditor" },
    ): void;
  };
  setTimeout(callback: () => void, ms?: number): FireworksTimer;
  setInterval(callback: () => void, ms?: number): FireworksTimer;
  clearTimer(timer: FireworksTimer): void;
}

/**
 * Opaque handle returned by OMP's context timers. Deliberately `unknown`: we
 * only ever hand it back to `clearTimer`, and typing it as OMP's internal
 * `Timer` would couple this module to a type it never inspects.
 */
export type FireworksTimer = unknown;

export interface ShowClaimFireworksOptions {
  /** Real lifetime of the non-modal widget. */
  durationMs?: number;
}

interface ActiveCelebration {
  finish(): void;
}

const activeCelebrations = new WeakMap<ClaimFireworksHost, ActiveCelebration>();

/**
 * Show one centered, animated, non-modal celebration above the editor.
 *
 * The returned promise settles after the real timer removes the widget. Calls
 * are intentionally fire-and-forget in claim paths; the editor stays focused.
 * Starting another celebration replaces the prior one without letting its
 * stale timer remove the new widget.
 */
export async function showClaimFireworks(
  host: ClaimFireworksHost,
  message: ClaimFireworksMessage | string,
  options: ShowClaimFireworksOptions = {},
): Promise<void> {
  if (process.env.ZCODE_CLAIM_FIREWORKS === "0") return;
  if (host.mode !== "tui" || !host.hasUI) return;

  // A scheduler created before an extension hot reload can retain the former
  // string payload contract. Normalize at this UI boundary so a live session
  // never crashes while source modules are being replaced.
  const card: ClaimFireworksMessage =
    typeof message === "string" ? { headline: "CLAIMED", lines: [message] } : message;
  activeCelebrations.get(host)?.finish();

  const { promise, resolve } = Promise.withResolvers<void>();
  let pump: FireworksTimer | undefined;
  let timeout: FireworksTimer | undefined;
  let finished = false;

  const state: ActiveCelebration = {
    finish(): void {
      if (finished) return;
      finished = true;
      if (pump !== undefined) host.clearTimer(pump);
      if (timeout !== undefined) host.clearTimer(timeout);
      if (activeCelebrations.get(host) === state) {
        activeCelebrations.delete(host);
        host.ui.setWidget(FIREWORKS_WIDGET_KEY, undefined);
      }
      resolve();
    },
  };
  activeCelebrations.set(host, state);

  host.ui.setWidget(
    FIREWORKS_WIDGET_KEY,
    (tui) => {
      const component = createFireworksComponent(card);
      pump = host.setInterval(() => tui.requestRender(), 1000 / FPS);
      return component;
    },
    { placement: "aboveEditor" },
  );

  timeout = host.setTimeout(state.finish, options.durationMs ?? DEFAULT_DURATION_MS);
  await promise;
}

/** Deterministic PRNG (mulberry32) so renders are reproducible in tests. */
function rng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** GitHub-dark truecolor palette, as full SGR foreground prefixes. */
const PALETTE = [
  "\x1b[38;2;121;192;255m",
  "\x1b[38;2;86;211;100m",
  "\x1b[38;2;227;179;65m",
  "\x1b[38;2;247;120;186m",
  "\x1b[38;2;163;113;247m",
];

function clampLine(line: string, width: number): string {
  // ANSI-aware clamp: measure only the visible text.
  const visible = line.replace(/\x1b\[[0-9;]*m/g, "");
  if (visible.length <= width) return line;
  let used = 0;
  let out = "";
  let inside = false;
  for (const char of line) {
    if (char === "\x1b") {
      inside = true;
      out += char;
      continue;
    }
    if (inside) {
      out += char;
      if (char === "m") inside = false;
      continue;
    }
    if (used >= width) break;
    out += char;
    used += 1;
  }
  return out;
}

function center(line: string, width: number): string {
  const visible = line.replace(/\x1b\[[0-9;]*m/g, "").length;
  const pad = Math.max(0, Math.floor((width - visible) / 2));
  return `${" ".repeat(pad)}${line}`;
}

/**
 * Render one animation frame.
 *
 * Tick 0 shows only the celebration line ("liftoff"); afterwards every burst
 * launched so far is drawn as an expanding ring whose radius follows its age,
 * so the sky animates outward instead of flickering random bars.
 */
export function fireworksFrame(tick: number, width: number, seed: number): string[] {
  const sky = Math.max(4, Math.min(10, Math.floor(width / 8)));
  const canvas: Array<Array<string | undefined>> = Array.from({ length: sky }, () => Array.from({ length: width }, () => undefined));

  // Each launch tick seeds one burst; a burst lives for RING_LIFE ticks and
  // expands one column per tick, which is what reads as a firework.
  for (let launch = 1; launch <= tick; launch++) {
    const age = tick - launch;
    if (age >= RING_LIFE) continue;
    const random = rng(seed + launch * 7919);
    const bursts = 1 + Math.floor(random() * 2);
    for (let b = 0; b < bursts; b++) {
      const cx = Math.floor(random() * width);
      const cy = Math.floor(random() * sky);
      const color = PALETTE[(launch + b) % PALETTE.length]!;
      const glyph = BURST_GLYPHS[Math.min(age, BURST_GLYPHS.length - 1)]!;
      const radius = age;
      const row = canvas[cy]!;
      const spark = `${color}${glyph}`;
      if (radius === 0) {
        if (cx >= 0 && cx < width) row[cx] = spark;
        continue;
      }
      // Ring arms only: the interior has already flown outward.
      for (const position of [cx - radius, cx + radius]) {
        if (position >= 0 && position < width) row[position] = spark;
      }
      // A shorter vertical pair gives the burst some body without filling it.
      const vertical = Math.max(1, Math.floor(radius / 2));
      for (const y of [cy - vertical, cy + vertical]) {
        if (y >= 0 && y < sky && cx >= 0 && cx < width) canvas[y]![cx] = spark;
      }
    }
  }

  const headline = `\x1b[1m🎉  CLAIMED  🎉\x1b[0m`;
  return [...canvas.map((row) => paintRow(row)), center(clampLine(headline, width), width)];
}

/** Ticks a burst stays visible before it burns out. */
const RING_LIFE = 6;

/**
 * Serialise one canvas row, coalescing neighbouring sparks of the same colour
 * into a single SGR run so a frame costs bytes proportional to its groups.
 */
function paintRow(row: Array<string | undefined>): string {
  let out = "";
  let open: string | undefined;
  for (const cell of row) {
    if (cell === undefined) {
      if (open !== undefined) {
        out += "\x1b[0m";
        open = undefined;
      }
      out += " ";
      continue;
    }
    const color = cell.slice(0, cell.lastIndexOf("m") + 1);
    const glyph = cell.slice(color.length);
    if (open !== color) {
      if (open !== undefined) out += "\x1b[0m";
      out += color;
      open = color;
    }
    out += glyph;
  }
  if (open !== undefined) out += "\x1b[0m";
  return out;
}

/**
 * Render-only widget component. It deliberately has no `handleInput`; keyboard
 * input remains owned by OMP's editor for the entire celebration.
 */
export function createFireworksComponent(message: ClaimFireworksMessage): FireworksComponent {
  const seed = Date.now() % 2147483647;
  let frame = 0;

  return {
    render(width: number): readonly string[] {
      const canvasWidth = Math.max(20, width);
      const sky = fireworksFrame(frame, canvasWidth, seed);
      frame += 1;
      return [
        ...sky,
        center(clampLine(`\x1b[1m${message.headline}\x1b[0m`, canvasWidth), canvasWidth),
        ...message.lines.map((line) => center(clampLine(line, canvasWidth), canvasWidth)),
      ];
    },

    invalidate(): void {
      // Stateless rendering; nothing cached to clear.
    },
  };
}

/** Frames per second the host should advance the animation. */
export const FIREWORKS_FPS = FPS;
