// One-off smoke test for the new /api/matrix/* control routes — spawns the
// real server as a child of THIS node process (rather than backgrounding it
// via the shell, which wasn't surviving in this sandbox), polls until it's
// up, hits every new route for real, then kills it. Not part of the test
// suite — delete after use.
import { spawn } from "node:child_process";

const child = spawn("node", ["server.js"], { stdio: ["ignore", "pipe", "pipe"] });
let out = "";
child.stdout.on("data", (d) => (out += d));
child.stderr.on("data", (d) => (out += d));

async function waitUntilUp(timeoutMs = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const r = await fetch("http://127.0.0.1:3001/api/health");
      if (r.ok) return true;
    } catch {}
    await new Promise((r) => setTimeout(r, 300));
  }
  return false;
}

const up = await waitUntilUp();
console.log("=== server up:", up, "===");
console.log("=== boot log so far ===\n" + out);

if (up) {
  const get = async (p) => (await fetch("http://127.0.0.1:3001" + p)).json();
  const post = async (p, body) =>
    (await fetch("http://127.0.0.1:3001" + p, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })).json();

  console.log("--- health ---", await get("/api/health").then(() => "ok"));
  console.log("--- matrix/status (fresh) ---", JSON.stringify(await get("/api/matrix/status")));
  console.log("--- matrix/command (poll) ---", JSON.stringify(await get("/api/matrix/command")));
  console.log("--- screens: bad (weather) ---", JSON.stringify(await post("/api/matrix/screens", { enabledScreens: ["portfolio", "weather"] })));
  console.log("--- screens: good ---", JSON.stringify(await post("/api/matrix/screens", { enabledScreens: ["news", "portfolio"] })));
  console.log("--- pin good ---", JSON.stringify(await post("/api/matrix/pin", { screen: "portfolio" })));
  console.log("--- pin bad (not enabled) ---", JSON.stringify(await post("/api/matrix/pin", { screen: "holdings" })));
  console.log("--- notify ---", JSON.stringify(await post("/api/matrix/notify", { text: "Button test!", durationSeconds: 15 })));
  console.log("--- command after notify ---", JSON.stringify(await get("/api/matrix/command")));
  console.log("--- test button ---", JSON.stringify(await post("/api/matrix/test", { label: "Button 1 Pressed" })));
  console.log("--- command after test ---", JSON.stringify(await get("/api/matrix/command")));
  console.log("--- status after all of the above ---", JSON.stringify(await get("/api/matrix/status")));
  console.log("--- matrix data (news/marketOpen present) ---", JSON.stringify(await get("/api/matrix")).slice(0, 1500));
  console.log("--- notify/clear ---", JSON.stringify(await post("/api/matrix/notify/clear", {})));
  console.log("--- command after clear ---", JSON.stringify(await get("/api/matrix/command")));
}

child.kill("SIGTERM");
await new Promise((r) => setTimeout(r, 500));
process.exit(0);
