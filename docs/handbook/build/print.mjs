// Print build + verify. Renders the handbook in PRINT media, screenshots the
// first pages so we can eyeball the print layout, then emits the bound A4 PDF.
//   run from repo root:  node docs/handbook/build/print.mjs
import { chromium } from "playwright";
import { mkdirSync } from "fs";

const ROOT = "C:/LUAN/19.CanvasMeet/docs/handbook";
const url = `file:///${ROOT}/dist/en/index.html`;
const outDir = `${ROOT}/dist`;
mkdirSync(outDir, { recursive: true });

const browser = await chromium.launch();
const page = await browser.newPage();
await page.goto(url, { waitUntil: "networkidle" });
await page.emulateMedia({ media: "print" });
await page.evaluate(() => document.fonts.ready);
await page.waitForTimeout(400);

// verification screenshots in PRINT media (so I can see exactly what prints)
const els = await page.$$(".page");
const names = ["cover", "divider", "opener", "prose", "steps", "plate", "gallery", "table", "card"];
for (let i = 0; i < els.length; i++) {
  await els[i].screenshot({ path: `C:/LUAN/19.CanvasMeet/_print-${i}-${names[i] || i}.png` });
}
console.log("print-media screenshots:", els.length);

// the actual bound A4 PDF (write to a fresh name; retry if a viewer locks it)
const pdfPath = `${outDir}/CanvasM-Handbook.pdf`;
try {
  await page.pdf({ path: pdfPath, preferCSSPageSize: true, printBackground: true, displayHeaderFooter: false });
  console.log("PDF →", pdfPath);
} catch (e) {
  console.warn("PDF write skipped (file locked? close the viewer):", e.code || e.message);
}

await browser.close();
console.log("DONE");
