/**
 * Test runner — `node test/run.js` from the repo root.
 *
 * There is no build step and no test framework on purpose: these are plain
 * node scripts that load the real source files against stubs. They cover the
 * two things that cannot be checked by reading the code —
 *   bundle.test.js          every content script loads in manifest order, every
 *                           feature registers, and the registry lifecycle is clean
 *   mount.test.js           the download button really lands in the player
 *                           controls, exactly once, and follows its setting
 *   popup-bridge.test.js    the popup's messaging contract, format grouping and
 *                           labelling, and the deciphered-`n` splicing
 *   download-engine.test.js chunks reassemble byte-exact out of order, the
 *                           connection cap holds, retries and cancel work
 * Everything else needs a real browser.
 */
"use strict";

const { execFileSync } = require("child_process");
const path = require("path");

const suites = ["bundle.test.js", "mount.test.js", "popup-bridge.test.js", "download-engine.test.js"];
let failed = 0;

for (const suite of suites) {
  console.log("\n── " + suite + " " + "─".repeat(Math.max(0, 50 - suite.length)));
  try {
    execFileSync(process.execPath, [path.join(__dirname, suite)], {
      cwd: path.join(__dirname, ".."),
      stdio: "inherit",
    });
  } catch (e) {
    failed++;
  }
}

console.log(failed ? "\n" + failed + " suite(s) failed" : "\nAll suites passed");
process.exit(failed ? 1 : 0);
