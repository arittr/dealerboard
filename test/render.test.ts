import { describe, expect, test } from "bun:test";
import type { KeyModel } from "../src/plugin/layout";
import { renderKey } from "../src/plugin/render";
import type { ProjectedSession } from "../src/protocol";

const DATA_URL_PREFIX = "data:image/svg+xml,";

const session = (overrides: Partial<ProjectedSession> = {}): ProjectedSession => ({
  provider: "claude",
  sessionId: "session-1",
  status: "idle",
  title: "A session",
  project: "stream-deck-agents",
  descendantCount: 0,
  logicalSlot: 1,
  ghosttyTerminalId: null,
  ...overrides,
});

const sessionModel = (
  overrides: Partial<ProjectedSession> = {},
  label = "A session",
  degraded = false,
): KeyModel => ({ kind: "session", session: session(overrides), label, degraded });

const blankModel = (degraded = false): KeyModel => ({ kind: "blank", degraded });

const nextModel = (degraded = false): KeyModel => ({ kind: "next", page: 1, pageCount: 3, degraded });

const decode = (model: KeyModel, phase: number): string => {
  const url = renderKey(model, phase);
  expect(url.startsWith(DATA_URL_PREFIX)).toBe(true);
  return decodeURIComponent(url.slice(DATA_URL_PREFIX.length));
};

const textNodes = (svg: string): string[] =>
  [...svg.matchAll(/<text\b[^>]*>([\s\S]*?)<\/text>/g)].map((match) => match[1]!);

const textNodesByClass = (svg: string, className: string): string[] =>
  [...svg.matchAll(new RegExp(`<text class="${className}"[^>]*>([\\s\\S]*?)</text>`, "g"))].map(
    (match) => match[1]!,
  );

const rectNodes = (svg: string): string[] =>
  [...svg.matchAll(/<rect\b[^>]*\/>/g)].map((match) => match[0]!);

const stripKnownEntities = (value: string): string =>
  value.replace(/&(amp|lt|gt|quot|apos);/g, "");

const codePointCount = (value: string): number => Array.from(value).length;

const hasLoneSurrogate = (value: string): boolean => {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) {
        return true;
      }
      index++;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
};

const frameOpacity = (model: KeyModel, phase: number): number => {
  const match = decode(model, phase).match(/opacity="([\d.]+)"/);
  expect(match).not.toBeNull();
  return Number.parseFloat(match![1]!);
};

describe("renderKey output contract", () => {
  test("returns a percent-encoded 144x144 SVG data URL with parseable boundaries", () => {
    const url = renderKey(sessionModel(), 0);
    expect(url.startsWith(DATA_URL_PREFIX)).toBe(true);
    // `#` would corrupt a data URL; percent-encoding must cover the colors.
    expect(url.slice(DATA_URL_PREFIX.length)).not.toContain("#");
    const svg = decode(sessionModel(), 0);
    expect(svg.startsWith("<svg")).toBe(true);
    expect(svg.endsWith("</svg>")).toBe(true);
    expect(svg).toContain('width="144"');
    expect(svg).toContain('height="144"');
  });

  test("escapes XML metacharacters in every text node", () => {
    const label = `<&>"'🚀é` + "Z".repeat(40); // e + combining acute (U+0301)
    const svg = decode(sessionModel({}, label), 3);
    // Escaped forms of every injected metacharacter are present.
    expect(svg).toContain("&lt;");
    expect(svg).toContain("&gt;");
    expect(svg).toContain("&amp;");
    expect(svg).toContain("&quot;");
    expect(svg).toContain("&apos;");
    // The emoji and the combining character survive intact.
    expect(svg).toContain("🚀");
    expect(svg).toContain("é");
    // No text node contains a raw metacharacter once known entities are removed.
    const nodes = textNodes(svg);
    expect(nodes.length).toBeGreaterThan(0);
    for (const node of nodes) {
      const stripped = stripKnownEntities(node);
      for (const metacharacter of ["<", ">", "&", '"', "'"]) {
        expect(stripped.includes(metacharacter)).toBe(false);
      }
    }
    expect(hasLoneSurrogate(svg)).toBe(false);
  });

  test("bounds the label by Unicode code points before splitting into two lines", () => {
    // 23 ascii points, then the rocket as the 24th code point. A UTF-16-unit
    // bound would slice the surrogate pair and break percent-encoding.
    const label = `${"x".repeat(23)}🚀tail beyond capacity`;
    const svg = decode(sessionModel({}, label), 0);
    const titles = textNodesByClass(svg, "title");
    expect(titles).toHaveLength(2);
    expect(titles.reduce((total, line) => total + codePointCount(line), 0)).toBe(24);
    for (const line of titles) {
      expect(codePointCount(line)).toBeLessThanOrEqual(12);
    }
    expect(titles[1]!.endsWith("🚀")).toBe(true);
    expect(hasLoneSurrogate(svg)).toBe(false);
  });

  test("renders one centered title line for short labels", () => {
    const svg = decode(sessionModel({}, "Short"), 0);
    expect(textNodesByClass(svg, "title")).toEqual(["Short"]);
    expect(svg).toContain('text-anchor="middle"');
  });

  test("renders the provider mark for each provider", () => {
    expect(textNodesByClass(decode(sessionModel({ provider: "claude" }), 0), "mark")).toEqual([
      "CL",
    ]);
    expect(textNodesByClass(decode(sessionModel({ provider: "codex" }), 0), "mark")).toEqual([
      "CO",
    ]);
    expect(textNodesByClass(decode(sessionModel({ provider: "kimi" }), 0), "mark")).toEqual([
      "KI",
    ]);
  });

  test("colors the provider chip per harness", () => {
    expect(decode(sessionModel({ provider: "claude" }), 0)).toContain("#D97757");
    expect(decode(sessionModel({ provider: "codex" }), 0)).toContain("#A855F7");
    expect(decode(sessionModel({ provider: "kimi" }), 0)).toContain("#3B82F6");
  });

  test("shows a bare descendant count only when greater than zero", () => {
    const without = decode(sessionModel({ descendantCount: 0 }, "Review"), 0);
    expect(textNodesByClass(without, "badge")).toHaveLength(0);
    const withCount = decode(sessionModel({ descendantCount: 7 }, "Review"), 0);
    expect(textNodesByClass(withCount, "badge")).toEqual(["7"]);
    expect(withCount).toContain(
      '<text class="badge" x="130" y="38" text-anchor="end" font-size="28"',
    );
  });
});

describe("status treatments", () => {
  test("working uses a tile wash behind content and a static dim blue frame", () => {
    const model = sessionModel({ status: "working" });
    const atZero = decode(model, 0);
    const atEight = decode(model, 8);
    expect(atZero).not.toContain("#FFB020");
    expect(atZero).not.toContain("#FF4D67");
    expect(atZero).not.toContain("stroke-dasharray");

    const findWorkingOverlay = (svg: string): string => {
      const overlay = rectNodes(svg).find(
        (rect) =>
          rect.includes('x="0"') &&
          rect.includes('y="0"') &&
          rect.includes('width="144"') &&
          rect.includes('height="144"') &&
          rect.includes('fill="#20B8FF"'),
      );
      expect(overlay).toBeDefined();
      return overlay!;
    };
    const findWorkingFrame = (svg: string): string => {
      const frame = rectNodes(svg).find((rect) => rect.includes('stroke="#20B8FF"'));
      expect(frame).toBeDefined();
      return frame!;
    };
    const overlayOpacity = (svg: string): number => {
      const match = findWorkingOverlay(svg).match(/opacity="([\d.]+)"/);
      expect(match).not.toBeNull();
      return Number.parseFloat(match![1]!);
    };

    const frameAtZero = findWorkingFrame(atZero);
    expect(frameAtZero).toContain('opacity="0.300"');
    expect(findWorkingFrame(atEight)).toBe(frameAtZero);
    expect(atZero.indexOf('fill="#20B8FF"')!).toBeLessThan(atZero.indexOf('class="title"'));

    const opacities = Array.from({ length: 33 }, (_, phase) => overlayOpacity(decode(model, phase)));
    expect(Math.min(...opacities)).toBeGreaterThanOrEqual(0.04);
    expect(Math.max(...opacities)).toBeLessThanOrEqual(0.14);
    expect(Math.max(...opacities)).toBeGreaterThan(Math.min(...opacities));
    expect(opacities[0]).toBe(opacities[32]);
  });

  test("waiting uses a #FFB020 sinusoidal frame opacity", () => {
    const model = sessionModel({ status: "waiting" });
    const atZero = decode(model, 0);
    const atFour = decode(model, 4);
    expect(atZero).toContain("#FFB020");
    expect(atZero).not.toContain("#20B8FF");
    expect(atZero).not.toContain("#FF4D67");
    expect(atZero).toContain('opacity="');
    expect(atZero).not.toBe(atFour);
  });

  test("error uses a #FF4D67 sinusoidal frame opacity", () => {
    const model = sessionModel({ status: "error" });
    const atZero = decode(model, 0);
    const atTwo = decode(model, 2);
    expect(atZero).toContain("#FF4D67");
    expect(atZero).not.toContain("#20B8FF");
    expect(atZero).not.toContain("#FFB020");
    expect(atZero).not.toBe(atTwo);
  });

  test("error pulses faster than waiting", () => {
    const errorModel = sessionModel({ status: "error" });
    const waitingModel = sessionModel({ status: "waiting" });
    const phases = Array.from({ length: 17 }, (_, index) => index);
    const errorOpacities = phases.map((phase) => frameOpacity(errorModel, phase));
    const waitingOpacities = phases.map((phase) => frameOpacity(waitingModel, phase));
    // Error completes a full sine cycle within sixteen phases; waiting needs
    // thirty-two, so only error reaches its dim minimum inside this window.
    expect(Math.min(...errorOpacities)).toBeLessThan(Math.min(...waitingOpacities));
  });

  test("idle uses one static #4ADE80 frame that ignores phase", () => {
    const model = sessionModel({ status: "idle" });
    const first = renderKey(model, 0);
    for (let phase = 1; phase < 8; phase++) {
      expect(renderKey(model, phase)).toBe(first);
    }
    const svg = decode(model, 0);
    expect(svg).toContain("#4ADE80");
    expect(svg).not.toContain("#20B8FF");
    expect(svg).not.toContain("#FFB020");
    expect(svg).not.toContain("#FF4D67");
  });
});

describe("non-session and degraded models", () => {
  test("blank keys render no text and ignore phase", () => {
    expect(textNodes(decode(blankModel(), 0))).toHaveLength(0);
    expect(renderKey(blankModel(), 5)).toBe(renderKey(blankModel(), 0));
  });

  test("a degraded blank key renders the offline treatment without a session title", () => {
    const svg = decode(blankModel(true), 2);
    expect(textNodesByClass(svg, "offline")).toEqual(["OFFLINE"]);
    expect(textNodesByClass(svg, "title")).toHaveLength(0);
  });

  test("NEXT renders paging text and no session title", () => {
    const svg = decode(nextModel(), 0);
    expect(textNodesByClass(svg, "next")).toEqual(["NEXT"]);
    expect(textNodesByClass(svg, "page")).toEqual(["1/3"]);
    expect(textNodesByClass(svg, "title")).toHaveLength(0);
    expect(renderKey(nextModel(), 7)).toBe(renderKey(nextModel(), 0));
  });

  test("a degraded NEXT key adds an error flag and still no session title", () => {
    const svg = decode(nextModel(true), 0);
    expect(textNodesByClass(svg, "flag")).toEqual(["!"]);
    expect(textNodesByClass(svg, "title")).toHaveLength(0);
  });

  test("a degraded session keeps its title and adds an error flag", () => {
    const clean = decode(sessionModel({}, "Keep me"), 0);
    const degraded = decode(sessionModel({}, "Keep me", true), 0);
    expect(textNodesByClass(clean, "flag")).toHaveLength(0);
    expect(textNodesByClass(degraded, "flag")).toEqual(["!"]);
    expect(degraded).toContain(
      '<text class="flag" x="16" y="128" text-anchor="start" font-size="16"',
    );
    expect(textNodesByClass(degraded, "title")).toEqual(textNodesByClass(clean, "title"));
  });
});
