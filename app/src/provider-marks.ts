/**
 * Strip-side provider mark and model-label helpers, split out of the retired
 * Stream Deck tile renderer. Pure and dependency-free so the browser bundle
 * can import them.
 */

import type { Provider } from "../../src/protocol";

const MODEL_LABEL_PREFIXES = ["claude-", "gpt-", "zai/", "openai/", "grok-"];

export const PROVIDER_LETTERS: Record<Provider, string> = {
  claude: "C",
  codex: "X",
  kimi: "K",
  pi: "P",
  omp: "O",
  zcode: "Z",
  deepseek: "D",
  grok: "G",
  qwen: "Q",
  evener: "E",
};

/**
 * Raw id to chip label: strip one vendor prefix (keeping the raw id if
 * stripping would leave nothing), then cap by code points with an ellipsis
 * on overflow.
 */
export const modelLabel = (model: string, maxCodePoints: number): string => {
  let label = model;
  for (const prefix of MODEL_LABEL_PREFIXES) {
    if (label.startsWith(prefix) && label.length > prefix.length) {
      label = label.slice(prefix.length);
      break;
    }
  }
  const points = Array.from(label);
  return points.length > maxCodePoints ? `${points.slice(0, maxCodePoints - 1).join("")}…` : label;
};
