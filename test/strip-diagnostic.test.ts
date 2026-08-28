import { describe, expect, test } from "bun:test";
import { createPointerDiagnostic } from "../app/src/diagnostic";

describe("createPointerDiagnostic", () => {
  test("attributes each layer separately: delivery counts, recognition, navigation, render", () => {
    const diag = createPointerDiagnostic(() => 1000);
    diag.recordPointer("down", 1);
    diag.recordPointer("move", 3);
    diag.recordPointer("up", 1);
    diag.recordIntents([{ kind: "swipe", direction: "next" }, { kind: "suppress-click" }]);
    diag.recordNavigation(0, 1);
    diag.recordRender();
    const lines = diag.summary();
    expect(lines).toHaveLength(4);
    expect(lines[0]).toContain("d1 m1 u1");
    expect(lines[0]).toContain("x3");
    // The WHOLE batch is visible: today's swipe emits swipe + suppress-click
    // in one feed, and showing only the tail would misreport recognition.
    expect(lines[1]).toContain('"swipe"');
    expect(lines[1]).toContain('"suppress-click"');
    expect(lines[2]).toContain("0→1");
    expect(lines[3]).toContain("1");
  });

  test("an empty feed is not a recognition event: the last real batch stays visible", () => {
    const diag = createPointerDiagnostic(() => 0);
    diag.recordIntents([{ kind: "swipe", direction: "next" }, { kind: "suppress-click" }]);
    diag.recordIntents([]);
    expect(diag.summary()[1]).toContain('"swipe"');
  });

  test("the move rate window forgets samples older than a second", () => {
    let now = 0;
    const diag = createPointerDiagnostic(() => now);
    for (let i = 0; i < 30; i += 1) {
      now += 10;
      diag.recordPointer("move", 1);
    }
    expect(diag.summary()[0]).toContain("30/s");
    now += 2000;
    diag.recordPointer("move", 1);
    expect(diag.summary()[0]).toContain("1/s");
  });

  test("a silent recognizer is visible: moves counted, no intents", () => {
    const diag = createPointerDiagnostic(() => 0);
    diag.recordPointer("move", 2);
    expect(diag.summary()[1]).toContain("none");
  });
});
