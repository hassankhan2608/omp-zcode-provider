/**
 * Sandbox stderr redirection tests.
 *
 * The vendored sandbox writes diagnostics straight to `process.stderr`
 * (`[captcha-guest-uncaught] …`). Upstream is a daemon whose stderr goes to
 * journald; OMP's worker thread shares the agent's stderr, so those writes
 * land on the TUI and corrupt the screen. This seam captures them instead.
 */
import { describe, expect, it } from "bun:test";
import { redirectStderr } from "../src/captcha-stderr.js";

function fakeStream(): { write: (chunk: unknown, a?: unknown, b?: unknown) => boolean; writes: unknown[] } {
  const writes: unknown[] = [];
  return {
    writes,
    write(chunk: unknown): boolean {
      writes.push(chunk);
      return true;
    },
  };
}

describe("redirectStderr", () => {
  it("forwards written text instead of letting it reach the real stream", () => {
    const stream = fakeStream();
    const seen: string[] = [];
    redirectStderr(stream, (line) => seen.push(line));

    const accepted = stream.write("[captcha-guest-uncaught] window is not defined\n");

    expect(accepted).toBe(true);
    expect(seen).toEqual(["[captcha-guest-uncaught] window is not defined"]);
    // Nothing may reach the terminal: that is the whole point of the seam.
    expect(stream.writes).toEqual([]);
  });

  it("decodes Buffer chunks, since the sandbox writes both forms", () => {
    const stream = fakeStream();
    const seen: string[] = [];
    redirectStderr(stream, (line) => seen.push(line));

    stream.write(Buffer.from("[guest-err] boom\n"));

    expect(seen).toEqual(["[guest-err] boom"]);
  });

  it("redacts opaque secrets before forwarding", () => {
    const stream = fakeStream();
    const seen: string[] = [];
    redirectStderr(stream, (line) => seen.push(line));

    stream.write(`[captcha-guest-uncaught] token ${"A".repeat(40)} rejected\n`);

    expect(seen[0]).toContain("[redacted 40 chars]");
    expect(seen[0]).not.toContain("AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA");
  });

  it("invokes the write callback so sandbox code that awaits a flush proceeds", () => {
    const stream = fakeStream();
    let called = false;
    redirectStderr(stream, () => {});

    stream.write("x\n", "utf-8", () => {
      called = true;
    });

    expect(called).toBe(true);
  });

  it("keeps accepting writes when the sink throws", () => {
    const stream = fakeStream();
    redirectStderr(stream, () => {
      throw new Error("sink is gone");
    });

    // A failed diagnostic must never become the sandbox's problem: the guest
    // is mid-solve and an exception here would abort an otherwise fine mint.
    expect(stream.write("still fine\n")).toBe(true);
  });

  it("restores the original write so a debug run keeps real diagnostics", () => {
    const stream = fakeStream();
    const restore = redirectStderr(stream, () => {});

    restore();
    stream.write("visible\n");

    expect(stream.writes).toEqual(["visible\n"]);
  });
});
