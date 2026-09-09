/** Full production bootstrap with synthetic native IO. No daemon/provider subprocesses. */
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const temporary = await mkdtemp(join(tmpdir(), "dealerboard-quota-preview-"));
const host = join(root, "test/fixtures/quota/preview-host.ts");
const entry = join(temporary, "preview.ts");
await Bun.write(
  entry,
  `
import { preview, scenarios, pushSnapshot, quotaFixture } from ${JSON.stringify(host)};
const params = new URLSearchParams(location.search);
preview.count = Math.max(1, Math.min(8, Number(params.get('count')) || (params.get('density') === 'compact' ? 4 : 2)));
preview.scenario = scenarios.find(s => s === params.get('scenario')) ?? 'healthy';
Date.now = () => preview.now;
const ticks = new Map();
const interval = globalThis.setInterval.bind(globalThis);
globalThis.setInterval = (fn, delay, ...args) => { ticks.set(delay, () => fn(...args)); return interval(fn, delay, ...args); };
const update = async (milliseconds = 0, publish = false) => {
  preview.now += milliseconds;
  if (publish) { ticks.get(10000)?.(); await new Promise(resolve => setTimeout(resolve, 0)); }
  pushSnapshot();
  ticks.get(1000)?.();
};
globalThis.quotaPreview = { preview, update, quotaFixture };
document.body.toggleAttribute('data-fullscreen', params.get('fullscreen') !== 'false');
const controls = document.createElement('form');
controls.id = 'preview-controls';
controls.innerHTML = '<label>Density <select name="density"><option>comfortable</option><option>compact</option></select></label> <label>Accounts per group <input name="count" type="number" min="1" max="8"></label> <label>Scenario <select name="scenario"></select></label> <label>Padding <select name="fullscreen"><option value="true">Fullscreen</option><option value="false">Normal</option></select></label> <button>Apply</button> <button type="button" id="advance">Advance 1 minute</button>';
document.body.append(controls);
controls.elements.density.value = params.get('density') === 'compact' ? 'compact' : 'comfortable';
controls.elements.count.value = preview.count;
controls.elements.fullscreen.value = params.get('fullscreen') === 'false' ? 'false' : 'true';
for (const scenario of scenarios) controls.elements.scenario.add(new Option(scenario, scenario));
controls.elements.scenario.value = preview.scenario;
document.querySelector('#advance').onclick = () => update(60000);
await import(${JSON.stringify(join(root, "app/src/main.ts"))});
`,
);

try {
  const built = await Bun.build({
    entrypoints: [entry],
    outdir: temporary,
    target: "browser",
    plugins: [
      {
        name: "synthetic-native-boundary",
        setup(build) {
          build.onResolve({ filter: /^\.\/bridge$/ }, () => ({ path: host }));
          build.onResolve({ filter: /^\.\/window$|^@tauri-apps\/plugin-autostart$/ }, (args) => ({
            path: args.path,
            namespace: "preview-native",
          }));
          build.onLoad({ filter: /.*/, namespace: "preview-native" }, () => ({
            loader: "js",
            contents:
              "export const startStripWindowManager = async () => {}; export const isEnabled = async () => true; export const enable = async () => { throw new Error('preview must not enable autostart'); };",
          }));
          build.onLoad({ filter: /\/quota-density\.ts$/ }, async (args) => ({
            loader: "ts",
            contents: (await readFile(args.path, "utf8")).replace(
              '= "comfortable";',
              '= new URLSearchParams(location.search).get("density") === "compact" ? "compact" : "comfortable";',
            ),
          }));
        },
      },
    ],
  });
  if (!built.success) throw new Error(built.logs.join("\n"));
  const html = (await readFile(join(root, "app/index.html"), "utf8"))
    .replace('src="./main.js"', 'src="./preview.js"')
    .replace(
      "</head>",
      "<style>body{overflow:auto}#strip{width:2560px;height:720px}#preview-controls{position:absolute;top:740px;left:20px;color:white;font:16px system-ui;padding-bottom:20px}#preview-controls input{width:60px}</style></head>",
    );
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      switch (new URL(request.url).pathname) {
        case "/":
          return new Response(html, { headers: { "Content-Type": "text/html" } });
        case "/preview.js":
          return new Response(Bun.file(join(temporary, "preview.js")));
        case "/styles.css":
          return new Response(Bun.file(join(root, "app/styles.css")));
        default:
          return new Response("Not found", { status: 404 });
      }
    },
  });
  const stop = async (): Promise<void> => {
    await server.stop(true);
    await rm(temporary, { recursive: true, force: true });
    process.exit(0);
  };
  process.once("SIGINT", () => {
    void stop();
  });
  process.once("SIGTERM", () => {
    void stop();
  });
  process.stdout.write(
    `Synthetic quota preview: ${server.url}\nCanvas: 2560 × 720; controls below canvas. Temporary assets: ${temporary}\n`,
  );
} catch (error) {
  await rm(temporary, { recursive: true, force: true });
  throw error;
}
