import { describe, expect, test } from "bun:test";
import { createIngestGate } from "../app/src/ingest-gate";

describe("createIngestGate", () => {
  test("a claim is current while no newer source has started", () => {
    const gate = createIngestGate();
    const read = gate.next();
    expect(gate.isCurrent(read)).toBe(true);
  });

  test("a push invalidates an outstanding read", () => {
    const gate = createIngestGate();
    const read = gate.next();
    gate.next(); // the push lands while the read is outstanding
    expect(gate.isCurrent(read)).toBe(false);
  });

  test("a newer read invalidates an older outstanding read", () => {
    const gate = createIngestGate();
    const first = gate.next();
    const second = gate.next();
    expect(gate.isCurrent(first)).toBe(false);
    expect(gate.isCurrent(second)).toBe(true);
  });

  test("tokens are unique and monotonically increasing", () => {
    const gate = createIngestGate();
    const tokens = [gate.next(), gate.next(), gate.next()];
    expect(new Set(tokens).size).toBe(3);
    expect(tokens[0]).toBeLessThan(tokens[1] ?? 0);
    expect(tokens[1]).toBeLessThan(tokens[2] ?? 0);
  });
});
