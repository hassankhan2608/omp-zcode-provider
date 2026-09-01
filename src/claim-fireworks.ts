/**
 * Fireworks celebration for successful ZCode claims.
 *
 * The TUI-native analog of `tui.codexResetFireworks` (the Codex resets
 * celebration): a transient, focused overlay with an animated firework burst,
 * dismissed with Escape — or automatically after `autoCloseMs`, because the
 * auto-claimer may fire while nobody is at the keyboard.
 *
 * Rendering is pure and seeded, so the visual is deterministic and testable;
 * the component only drives time and input.
 */

/** Seconds→tick pacing for the animation loop (frames per second). */
const FPS = 12;
/** Burst glyphs, brightest first — pure ANSI text, no theme dependency. */
const BURST_GLYPHS = ["✦", "✧", "✶", "✷", "*"];

/**
 * Minimal host surface needed to present the overlay — the slice of OMP's
 * `ExtensionContext` this helper consumes, so tests can stub it.
 */
export interface ClaimFireworksHost {
  mode: string;
  hasUI: boolean;
  ui: {
    custom<T>(
      factory: (tui: { requestRender(): void }, theme: unknown, keybindings: unknown, done: (result?: T) => void) => unknown,
    ): Promise<T | undefined>;
  };
}

/**
 * Present the fireworks overlay for one successful claim.
 *
 * No-op outside the interactive TUI or when `ZCODE_CLAIM_FIREWORKS=0`.
 * Dismissal: Escape (like the Codex resets celebration), or automatically
 * after `autoCloseMs` on the auto-claimer path, where nobody may be watching.
 */
export async function showClaimFireworks(
  host: ClaimFireworksHost,
  line: string,
  options: { autoCloseMs?: number } = {},
): Promise<void> {
  if (process.env.ZCODE_CLAIM_FIREWORKS === "0") return;
  if (host.mode !== "tui" || !host.hasUI) return;

  await host.ui.custom<void>((tui, _theme, _keybindings, done) => {
    const { promise, resolve } = Promise.withResolvers<void>();
    let finished = false;
    // Drive the animation first: onFinish (Escape or auto-close) clears it,
    // and the host may pump frames while the component is being created.
    const pump = setInterval(() => tui.requestRender(), 1000 / FPS);
    // Never keep OMP alive for a celebration.
    pump.unref?.();
    const component = createFireworksComponent({
      line,
      width: 80,
      ...(options.autoCloseMs !== undefined ? { autoCloseMs: options.autoCloseMs, now: Date.now } : {}),
      onFinish: () => {
        finished = true;
        clearInterval(pump);
        resolve();
        done();
      },
    });
    return component;
  });
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

export interface FireworksComponentOptions {
  /** The claim message displayed under the animation. */
  line: string;
  /** Render width used for clamping before the TUI measures the terminal. */
  width: number;
  /** Auto-dismiss after this many ms; omit to remain until Escape. */
  autoCloseMs?: number;
  /** Injected clock for auto-close expiry (tests). */
  now?: () => number;
  /** Called exactly once when the overlay should close. */
  onFinish(): void;
}

export interface FireworksComponent {
  render(width: number): readonly string[];
  handleInput?(data: string): void;
  invalidate?(): void;
}

/**
 * Build the overlay component. The host TUI drives rendering; `handleInput`
 * receives raw terminal data (Escape = `\x1b`) and empty data may be used by
 * the host as an expiry tick.
 */
export function createFireworksComponent(options: FireworksComponentOptions): FireworksComponent {
  const now = options.now ?? Date.now;
  const startedAt = now();
  const seed = startedAt % 2147483647;
  let finished = false;
  let frame = 0;

  const finish = (): void => {
    if (finished) return;
    finished = true;
    options.onFinish();
  };

  return {
    render(width: number): readonly string[] {
      if (finished) return [];
      const canvasWidth = Math.max(20, width);
      const sky = fireworksFrame(frame, canvasWidth, seed);
      frame += 1;
      return [
        ...sky,
        center(clampLine(options.line, canvasWidth), canvasWidth),
        center(clampLine("\x1b[2mesc to dismiss\x1b[0m", canvasWidth), canvasWidth),
      ];
    },

    handleInput(data: string): void {
      if (finished) return;
      // The host may deliver empty data as a render/expiry tick.
      if (data.length === 0) {
        if (options.autoCloseMs !== undefined && now() - startedAt >= options.autoCloseMs) finish();
        return;
      }
      if (data === "\x1b" || data === "q" || data === "Q") finish();
    },

    invalidate(): void {
      // Stateless rendering; nothing cached to clear.
    },
  };
}

/** Frames per second the host should advance the animation. */
export const FIREWORKS_FPS = FPS;
