/** Run with an existing Playwright module; no installation or production IO.
 * node test/fixtures/quota/browser-check.mjs URL PLAYWRIGHT_MODULE ENGINE EVIDENCE_DIRECTORY
 */
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const [url, modulePath, engine, evidence] = process.argv.slice(2);
assert(url && modulePath && engine && evidence, "URL, module path, engine, evidence directory required");
const playwright = await import(pathToFileURL(modulePath).href);
const browser = await playwright[engine].launch();
const context = await browser.newContext({ viewport: { width: 2560, height: 720 }, hasTouch: true });
const page = await context.newPage();
await page.addInitScript(() => localStorage.removeItem("agent-strip.layout.v1"));
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
await mkdir(evidence, { recursive: true });
const results = { engine, version: browser.version(), layouts: [], interactions: [] };
const scenarios = [
  "healthy",
  "exhausted waiting account",
  "auth required",
  "unavailable with future reset",
  "stale after reset",
  "unknown reset",
  "long scoped tags",
];
const navigate = async (density, scenario = "healthy", fullscreen = "true") => {
  await page.goto(`${url}?${new URLSearchParams({ density, scenario, fullscreen })}`);
  await page.waitForSelector(".quota-account");
  await page.waitForSelector(".card");
  await page.evaluate(() => {
    for (const animation of document.getAnimations()) animation.pause();
  });
};
try {
  for (const density of ["comfortable", "compact"]) {
    for (const fullscreen of ["true", "false"]) {
      for (const scenario of scenarios) {
        await navigate(density, scenario, fullscreen);
        const geometry = await page.locator("#rail").evaluate((rail) => {
          const bounds = rail.getBoundingClientRect();
          const failures = [];
          const selectors =
            ".rail-quota-zone,.rail-quota,.quota-account,.quota-single-reading,.quota-right,.quota-note,.quota-pct,.quota-age-cue";
          for (const element of rail.querySelectorAll(selectors)) {
            const rect = element.getBoundingClientRect();
            if (
              rect.left < bounds.left - 1 ||
              rect.right > bounds.right + 1 ||
              rect.top < bounds.top ||
              rect.bottom > bounds.bottom
            )
              failures.push(`${element.className}: outside rail`);
            if (element.scrollWidth > element.clientWidth + 1 || element.scrollHeight > element.clientHeight + 1)
              failures.push(`${element.className}: overflowing content`);
            if (element.matches(".quota-account,.quota-right")) {
              const children = [...element.children].map((child) => child.getBoundingClientRect());
              for (let i = 1; i < children.length; i++)
                if (children[i].left < children[i - 1].right - 1)
                  failures.push(`${element.className}: overlapping children`);
            }
          }
          const blocks = [...rail.children, ...rail.querySelector(".rail-quota-zone").children].map((element) =>
            element.getBoundingClientRect(),
          );
          for (let i = 1; i < 3; i++)
            if (blocks[i].top < blocks[i - 1].bottom - 1) failures.push("rail blocks overlap");
          const rows = [...rail.querySelectorAll(".quota-account,.quota-single-reading")];
          for (let i = 1; i < rows.length; i++)
            if (rows[i].getBoundingClientRect().top < rows[i - 1].getBoundingClientRect().bottom - 1)
              failures.push("quota rows overlap");
          const pct = rail.querySelector(".quota-pct");
          const note = rail.querySelector(".quota-note");
          return {
            failures,
            rail: { width: bounds.width, height: bounds.height },
            rows: rows.length,
            rowHeight: rows[0].getBoundingClientRect().height,
            scroll: rail.scrollHeight > rail.clientHeight,
            ratio:
              Number.parseFloat(getComputedStyle(note).fontSize) / Number.parseFloat(getComputedStyle(pct).fontSize),
            text: rail.textContent,
          };
        });
        assert.deepEqual(geometry.failures, [], `${density}/${fullscreen}/${scenario}`);
        assert.equal(geometry.rows, density === "comfortable" ? 7 : 11);
        assert.equal(geometry.rowHeight, density === "comfortable" ? 40 : 31);
        assert.equal(geometry.rail.width, 638);
        assert.equal(geometry.rail.height, 720);
        assert.equal(geometry.scroll, false);
        assert.equal(geometry.ratio, 0.875);
        assert(geometry.text.includes("6 unread"));
        assert(geometry.text.includes("100%"));
        assert(geometry.text.includes("3h 30m"));
        assert(geometry.text.includes("3d"));
        if (scenario === "auth required") assert(geometry.text.includes("Sign in again"));
        if (scenario === "unavailable with future reset") assert(geometry.text.includes("2h+ old"));
        if (scenario === "unknown reset") assert(geometry.text.includes("reset unknown"));
        if (scenario === "long scoped tags") assert(geometry.text.includes("WWWWWWWWWWWWW…"));
        if (fullscreen === "true")
          await page.screenshot({
            path: join(evidence, `${engine}-${density}-${scenario.replaceAll(" ", "-")}.png`),
            clip: { x: 0, y: 0, width: 2560, height: 720 },
          });
        results.layouts.push({ density, fullscreen, scenario, ...geometry });
      }
    }
    await navigate(density);
    const account = page.locator('[data-quota-provider="codex"][data-quota-account]').nth(1);
    const dialog = page.locator(".quota-details");
    const close = page.locator(".quota-details-close");
    const title = async () => assert.equal(await dialog.getAttribute("aria-label"), "Codex account 2");
    await account.focus();
    await page.keyboard.press("Enter");
    await title();
    assert((await dialog.innerText()).includes("Active account is not reported"));
    await page.keyboard.press("Tab");
    assert(await close.evaluate((e) => e === document.activeElement));
    await page.evaluate(async () => {
      await globalThis.quotaPreview.update(60_000);
    });
    await page.keyboard.press("Escape");
    assert.equal(await dialog.count(), 0);
    assert(await account.evaluate((e) => e === document.activeElement));
    await account.tap();
    await title();
    await close.click();
    assert.equal(await dialog.count(), 0);
    await account.click();
    await title();
    await page.touchscreen.tap(100, 100);
    assert.equal(await dialog.count(), 0);
    // Real mouse stroke, source update and countdown rollover before release.
    await page.evaluate(async () => {
      const q = globalThis.quotaPreview;
      q.preview.quota = q.quotaFixture(q.preview.count, "healthy");
      q.preview.quota.providers.codex.accounts[1].resetAt = new Date(q.preview.now + 90_000).toISOString();
      await q.update(0, true);
    });
    assert.equal(await account.locator(".quota-note").innerText(), "2m");
    const box = await account.boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await account.evaluate((e) => {
      globalThis.pressedQuotaElement = e;
    });
    await page.evaluate(async () => {
      const q = globalThis.quotaPreview;
      q.preview.quota.providers.codex.accounts[1].percentRemaining = 37;
      await q.update(60_000, true);
    });
    assert(
      await account.evaluate((e) => e === globalThis.pressedQuotaElement),
      "rail must defer replacement during press",
    );
    assert.equal(await account.locator(".quota-note").innerText(), "2m", "held rail keeps its pre-press countdown");
    await page.mouse.up();
    await title();
    assert.equal(await account.locator(".quota-note").innerText(), "1m");
    assert.equal(await dialog.locator(".quota-detail-reset").first().innerText(), "1m");
    assert((await dialog.innerText()).includes("37% remaining"));
    assert((await dialog.innerText()).includes("Last measured 4m ago"));
    // Modal gestures cannot reach board routing or paging.
    const beforeBoard = await page.locator("#board").innerHTML();
    await page.mouse.move(2200, 230);
    await page.mouse.wheel(900, 500);
    await page.waitForTimeout(200);
    assert.equal(await page.locator("#board").innerHTML(), beforeBoard);
    assert.deepEqual(await page.evaluate(() => globalThis.quotaPreview.preview.calls), []);
    await close.click();
    // Release on a sibling must not retarget the captured account.
    const sibling = await page.locator('[data-quota-provider="codex"][data-quota-account]').first().boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(sibling.x + sibling.width / 2, sibling.y + sibling.height / 2);
    await page.mouse.up();
    assert.equal(await dialog.count(), 0);
    await account.click();
    await page.evaluate(async () => {
      const q = globalThis.quotaPreview;
      q.preview.quota.providers.codex.accounts[1].extraWindows = Array.from({ length: 8 }, (_, i) => ({
        id: `synthetic-${i}`,
        label: `Scoped ${i}`,
        percentRemaining: 50 + i,
        resetAt: null,
      }));
      await q.update(0, true);
    });
    assert.equal(await dialog.locator(".quota-detail-window").count(), 10);
    const body = dialog.locator(".quota-details-body");
    assert(await body.evaluate((e) => e.scrollHeight > e.clientHeight));
    const scrollTop = await body.evaluate((e) => {
      e.scrollTop = 80;
      return e.scrollTop;
    });
    await page.evaluate(async () => {
      await globalThis.quotaPreview.update(60_000);
    });
    assert.equal(await body.evaluate((e) => e.scrollTop), scrollTop);
    assert(await close.evaluate((e) => e === document.activeElement));
    await page.screenshot({ path: join(evidence, `${engine}-${density}-details.png`) });
    await page.evaluate(async () => {
      const q = globalThis.quotaPreview;
      q.preview.quota.providers.codex.accounts.splice(1, 1);
      await q.update(0, true);
    });
    assert.equal(await dialog.count(), 0);
    assert.equal(await page.evaluate(() => document.activeElement.id), "rail");
    await page.evaluate(async () => {
      await globalThis.quotaPreview.update(60_000);
    });
    assert.equal(await dialog.count(), 0);
    // Existing board tap, session sheet and paging still use production wiring.
    await page.locator("#board .card").first().click();
    assert(
      (await page.evaluate(() => globalThis.quotaPreview.preview.calls)).some((call) => call.command === "viewSession"),
    );
    await page.locator("#board .card").first().click({ button: "right" });
    assert.equal(await page.locator(".action-sheet").count(), 1);
    await page.keyboard.press("Escape");
    const firstCard = await page.locator("#board .card").first().getAttribute("data-card-key");
    await page.mouse.move(1600, 350);
    await page.mouse.down();
    await page.mouse.move(600, 350, { steps: 10 });
    await page.mouse.up();
    await page.waitForTimeout(300);
    assert.notEqual(await page.locator("#board .card").first().getAttribute("data-card-key"), firstCard);
    results.interactions.push({
      density,
      passed: [
        "keyboard open",
        "focus trap",
        "Escape/focus after rerender",
        "touch open",
        "close",
        "outside tap",
        "mouse snapshot/countdown race",
        "modal wheel isolation",
        "no quota session action",
        "sibling release rejected",
        "ten-window detail scroll and focus retained on update",
        "removed account dismisses to rail without reopening",
        "board tap restored",
        "session sheet restored",
        "board swipe restored",
      ],
    });
  }
  assert.deepEqual(errors, []);
  await writeFile(join(evidence, `${engine}-results.json`), `${JSON.stringify(results, null, 2)}\n`);
  process.stdout.write(
    `${engine} ${results.version}: ${results.layouts.length} layouts, ${results.interactions.length} interaction suites passed; no page errors\n`,
  );
} finally {
  await browser.close();
}
