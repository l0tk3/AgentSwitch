import { describe, expect, it } from "vitest";
import { modelName } from "../src/util/modelName.js";

describe("model names as people say them", () => {
  it("covers the catalog's ids", () => {
    expect(modelName("claude-opus-5-5")).toBe("Opus 5.5");
    expect(modelName("claude-opus-5-5[1m]")).toBe("Opus 5.5 1M");
    expect(modelName("claude-sonnet-4-6")).toBe("Sonnet 4.6");
    expect(modelName("claude-haiku-4-5-20251001")).toBe("Haiku 4.5");
    expect(modelName("deepseek/deepseek-flash")).toBe("DeepSeek Flash");
    expect(modelName("gpt-6-luna")).toBe("GPT-6 Luna");
    expect(modelName("gpt-5.5")).toBe("GPT-5.5");
  });
});
