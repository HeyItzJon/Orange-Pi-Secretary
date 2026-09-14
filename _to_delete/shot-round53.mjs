// shot-round53.mjs — Round 53: new "System" health page, right after
// "Wall" in the nav. Verifies the page renders the problems banner, host
// stats, service rows, and source rows, using harness.jsx's mocked
// /api/system-health route.
import { chromium } from "playwright";

const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium" });
const errors = [];

async function shot(name, key, w, h, fn) {
  const pg = await browser.newPage({ viewport: { width: w, height: h }, deviceScaleFactor: 2 });
  pg.on("console", (m) => m.type() === "error" && errors.push(`${name}: ${m.text()}`));
  pg.on("pageerror", (e) => errors.push(`${name}: ${e.message}`));
  await pg.goto(`file://${process.cwd()}/index.html?page=${key}`);
  await pg.waitForTimeout(700);
  if (fn) await fn(pg);
  await pg.screenshot({ path: `${name}.png`, fullPage: true });
  await pg.close();
}

// pages array (demo.json): today, week, tasks, money, year, wall, system —
// index 6, so key "7" (1-based key handler in Display.jsx).
await shot("r53-system-desktop", 7, 1440, 900);
await shot("r53-system-phone", 7, 420, 900);

// Confirm the problems banner rendered the mocked marketNews warning, and
// that a healthy source (money) does not appear in it.
{
  const pg = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  pg.on("console", (m) => m.type() === "error" && errors.push(`content-check: ${m.text()}`));
  pg.on("pageerror", (e) => errors.push(`content-check: ${e.message}`));
  await pg.goto(`file://${process.cwd()}/index.html?page=7`);
  await pg.waitForTimeout(700);
  const problemsText = await pg.$eval(".syproblems", (el) => el.textContent).catch(() => null);
  console.log(`problems banner text: ${JSON.stringify(problemsText)}`);
  const cpuVal = await pg.$eval(".systat-val", (el) => el.textContent).catch(() => null);
  console.log(`first stat value (CPU temp): ${JSON.stringify(cpuVal)}`);
  const rows = await pg.$$eval(".syrow .syname", (els) => els.map((e) => e.textContent));
  console.log(`service+source rows: ${JSON.stringify(rows)}`);
  await pg.close();
}

console.log(errors.length ? `\nCONSOLE ERRORS:\n${errors.join("\n")}` : "\nno console errors");
await browser.close();
