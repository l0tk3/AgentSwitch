/** Times in the conversation read like the apps' (2026-09-25): the update notice said "构建于 2026-09-25T12:24:09Z". */

import { describe, expect, it } from "vitest";
import { localTime } from "../src/util/localTime.js";

describe("local times for people", () => {
  const now = new Date(2026, 8, 25, 21, 0);
  it("today, yesterday, else the date; always the Mac's clock", () => {
    expect(localTime(new Date(2026, 8, 25, 20, 24).toISOString(), now)).toBe("今天 20:24");
    expect(localTime(new Date(2026, 8, 24, 7, 5).toISOString(), now)).toBe("昨天 07:05");
    expect(localTime(new Date(2026, 8, 20, 17, 12).toISOString(), now)).toBe("9月20日 17:12");
  });

  it("what is not a date stays as it is", () => {
    expect(localTime("A", now)).toBe("A");
    expect(localTime("", now)).toBe("未知时间");
  });
});
