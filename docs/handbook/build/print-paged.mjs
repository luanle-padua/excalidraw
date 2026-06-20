// Paged.js paginated → bound A4 PDF. Served over HTTP because Paged.js fetches
// the linked stylesheets to paginate (file:// blocks fetch).
//   node docs/handbook/build/print-paged.mjs
import { chromium } from "playwright";
import { mkdirSync } from "fs";
import { readFile } from "fs/promises";
import { extname } from "path";
import http from "http";

const ROOT = "C:/LUAN/19.CanvasMeet/docs/handbook";
mkdirSync(`${ROOT}/dist`, { recursive: true });

const MIME = { ".html": "text/html", ".css": "text/css", ".js": "text/javascript", ".svg": "image/svg+xml", ".png": "image/png", ".json": "application/json", ".woff2": "font/woff2" };
const server = http.createServer(async (req, res) => {
  try {
    const p = ROOT + decodeURIComponent(req.url.split("?")[0]);
    const data = await readFile(p);
    res.writeHead(200, { "content-type": MIME[extname(p)] || "application/octet-stream" });
    res.end(data);
  } catch { res.writeHead(404); res.end("404"); }
});
await new Promise((r) => server.listen(0, r));
const port = server.address().port;
const url = `http://localhost:${port}/dist/en/index.html`;

const browser = await chromium.launch();
const page = await browser.newPage({ deviceScaleFactor: 2 });
page.on("console", (m) => { if (m.type() === "error") console.log("[err]", m.text().slice(0, 200)); });
page.on("pageerror", (e) => console.log("[pageerror]", String(e).slice(0, 240)));
await page.goto(url, { waitUntil: "networkidle" });
await page.waitForSelector(".pagedjs_page", { timeout: 120000 });
// Paged.js fires PagedConfig.after when pagination is fully complete
await page.waitForFunction(() => window.__pagedDone === true, { timeout: 600000, polling: 1000 });
await page.evaluate(() => document.fonts && document.fonts.ready);
await page.waitForTimeout(800);

const count = await page.evaluate(() => document.querySelectorAll(".pagedjs_page").length);
console.log("paged pages:", count);
const leaves = await page.$$(".pagedjs_page");
for (let i = 0; i < Math.min(leaves.length, 14); i++)
  await leaves[i].screenshot({ path: `C:/LUAN/19.CanvasMeet/_pg-${String(i).padStart(2, "0")}.png` }).catch(() => {});

try {
  await page.pdf({ path: `${ROOT}/dist/CanvasM-Handbook.pdf`, preferCSSPageSize: true, printBackground: true });
  console.log("PDF →", `${ROOT}/dist/CanvasM-Handbook.pdf`);
} catch (e) { console.warn("PDF skipped:", e.code || e.message); }
await browser.close();
server.close();
console.log("DONE");
