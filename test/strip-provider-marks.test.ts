import { describe, expect, test } from "bun:test";
import { modelLabel, PROVIDER_LETTERS } from "../app/src/provider-marks";

describe("modelLabel", () => {
  test("strips one known vendor prefix", () => {
    expect(modelLabel("claude-fable-5", 10)).toBe("fable-5");
    expect(modelLabel("gpt-5.6-luna", 10)).toBe("5.6-luna");
    expect(modelLabel("zai/glm-5.3", 10)).toBe("glm-5.3");
    expect(modelLabel("openai/o3", 10)).toBe("o3");
    expect(modelLabel("grok-4.6", 10)).toBe("4.6");
  });

  test("keeps an unprefixed id", () => {
    expect(modelLabel("k3", 10)).toBe("k3");
  });

  test("keeps the raw id when stripping would empty it", () => {
    expect(modelLabel("gpt-", 10)).toBe("gpt-");
    expect(modelLabel("claude-", 10)).toBe("claude-");
  });

  test("caps by code points with an ellipsis", () => {
    expect(modelLabel("someverylongmodel", 10)).toBe("someveryl…");
    expect(modelLabel("someverylongmodel", 6)).toBe("somev…");
    expect(modelLabel("k3", 6)).toBe("k3");
  });

  test("counts code points, not UTF-16 code units", () => {
    expect(modelLabel("🚀🚀🚀🚀🚀🚀", 3)).toBe("🚀🚀…");
  });
});

describe("PROVIDER_LETTERS", () => {
  test("maps every provider to its chip letter", () => {
    expect(PROVIDER_LETTERS).toEqual({
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
    });
  });
});
