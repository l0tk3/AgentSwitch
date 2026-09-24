import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { execRunner } from "../src/remote/tailscale.js";

describe("tailscale CLI runner", () => {
  it("forces CLI mode: the app bundle's binary opens its GUI when started without a terminal", async () => {
    const bin = join(mkdtempSync(join(tmpdir(), "ts-cli-")), "tailscale");
    writeFileSync(bin, "#!/bin/sh\nprintf '%s' \"$TAILSCALE_BE_CLI\"\n");
    chmodSync(bin, 0o755);
    expect(await execRunner(bin, ["ip", "-4"])).toBe("1");
  });
});
