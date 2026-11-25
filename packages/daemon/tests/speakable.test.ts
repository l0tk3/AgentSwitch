import { describe, expect, it } from "vitest";
import { speakable } from "../src/util/speakable.js";

describe("speakable: what a voice may read", () => {
  it("drops ciphertexts next to Chinese, links, Markdown, and keeps emails intact", () => {
    const token = "enc:v1:" + "A".repeat(40);
    expect(speakable(`密码是${token}，已填入`)).toBe("密码是，已填入");
    expect(speakable("发到 alice@example.com，并 @ 了 @chenju_ai")).toBe("发到 alice@example.com，并 @ 了 chenju_ai");
    expect(speakable("见 [removed: not a secret-gate token] 这里")).toBe("见 这里");
  });

  it("drops long random-looking strings but keeps words and plain numbers", () => {
    expect(speakable("会话 sk_live_9fQ2xLmP4rT8wZ1c 已失效")).toBe("会话 已失效");
    expect(speakable("共 12 条，version2 正常")).toBe("共 12 条，version2 正常");
  });
});
