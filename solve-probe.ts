/**
 * Isolation probe. Loads `@oh-my-pi/pi-ai` and installs OMP-shaped
 * `unhandledRejection` listeners that FAIL the probe if they ever fire, then
 * runs repeated solves. Proves sandbox rejections never reach the main thread.
 *
 * Not part of the test suite; run manually with `bun run`.
 */
import "@oh-my-pi/pi-ai";
import { getCaptchaToken, shutdownCaptcha } from "./src/captcha.js";
import { ZCODE_APP_VERSION } from "./src/identity-context.js";

let leaked = 0;
// Exactly what OMP does: its own listener, which upstream's in-file handler
// cannot suppress. If the sandbox is properly isolated this never fires.
process.on("unhandledRejection", (reason: unknown) => {
  leaked += 1;
  console.log(`LEAKED TO MAIN THREAD #${leaked}: ${String(reason).slice(0, 140)}`);
});
process.on("uncaughtException", (error: Error) => {
  leaked += 1;
  console.log(`LEAKED UNCAUGHT #${leaked}: ${error.message.slice(0, 140)}`);
});

let solved = 0;
for (let attempt = 1; attempt <= 4; attempt++) {
  const started = Date.now();
  try {
    const token = await getCaptchaToken(ZCODE_APP_VERSION);
    solved += 1;
    console.log(`SOLVE ${attempt}: ok in ${Date.now() - started}ms len=${token.verifyParam.length}`);
  } catch (error) {
    console.log(`SOLVE ${attempt}: failed in ${Date.now() - started}ms — ${String(error).slice(0, 120)}`);
  }
}

// Give late sandbox promise chains time to reject.
await new Promise((resolve) => setTimeout(resolve, 4_000));
console.log(`RESULT solved=${solved}/4 leakedToMainThread=${leaked}`);
shutdownCaptcha();
process.exit(leaked === 0 ? 0 : 1);
