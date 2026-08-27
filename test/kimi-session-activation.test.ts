import { describe, expect, test } from "bun:test";
import { createKimiSessionActivator, type OpenUrl } from "../src/plugin/kimi-session-activation";

describe("Kimi Web session activation", () => {
  test("opens one encoded technical session ID at the fixed local Web origin", async () => {
    const urls: string[] = [];
    const openUrl: OpenUrl = (url) => {
      urls.push(url);
      return Promise.resolve();
    };
    const activate = createKimiSessionActivator(openUrl);

    await activate("session/one?two space;ü$HOME&`");

    expect(urls).toEqual(["http://127.0.0.1:58627/sessions/session%2Fone%3Ftwo%20space%3B%C3%BC%24HOME%26%60"]);
  });

  test("propagates a URL opener rejection", async () => {
    const failure = new Error("open failed");
    const activate = createKimiSessionActivator(() => Promise.reject(failure));

    await expect(activate("session-id")).rejects.toBe(failure);
  });
});
