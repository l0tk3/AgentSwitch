/** What a profile keeps sealed moves off the gate's ciphertexts to the vault's own key (vault/seal.ts, sealedMove.ts;
 *  user #369). */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ProfileStore } from "../src/profiles/store.js";
import { moveSealed } from "../src/sealedMove.js";
import { isVaultSealed, openValue, sealValue, vaultOpener } from "../src/vault/seal.js";

const KEY = Buffer.alloc(32, 9);
const ENC = (n: string) => `enc:v1:${n.repeat(30)}`;

describe("values sealed under the vault's key", () => {
  it("open under the key they were sealed with, or one kept before; a gate's ciphertext goes to the gate while there is one", async () => {
    const t = sealValue(KEY, "sk-secret-值");
    expect(t).toMatch(/^asv:1:[A-Za-z0-9_-]{16,}$/);
    expect(t).not.toContain("sk-secret");
    expect(openValue([Buffer.alloc(32, 1), KEY], t)).toBe("sk-secret-值");
    expect(() => openValue([Buffer.alloc(32, 1)], t)).toThrow();
    const asked: string[] = [];
    const open = vaultOpener([KEY], async (token) => { asked.push(token); return { value: "from-gate", label: "g" }; });
    expect((await open(t, [])).value).toBe("sk-secret-值");
    expect((await open(ENC("A"), ["https://x/"])).value).toBe("from-gate");
    expect(asked).toEqual([ENC("A")]);
    await expect(vaultOpener([KEY], null)(ENC("A"), [])).rejects.toThrow(/no gate/);
  });

  it("moves each profile's API key, proxy password and session key, and the shared browser's proxy password, once", async () => {
    const root = mkdtempSync(join(tmpdir(), "as-move-"));
    const store = new ProfileStore({ home: join(root, "as"), userHome: join(root, "user"), now: () => 1 });
    const api = store.create("claude-code", "Keyed", "api", { key: ENC("K"), baseUrl: "https://api.vendor.example/v1" });
    const sub = store.create("claude-code", "Work", "subscription");
    store.setProxy("claude-code", sub.id, { server: "http://proxy.example:8080", username: "u", password: ENC("P") });
    store.setSessionKey("claude-code", sub.id, ENC("S"));
    store.setProxy("codex", "default", { server: "http://127.0.0.1:1", username: "u", password: ENC("X") });
    let shared = ENC("B");
    const identity = { sealedPassword: () => ({ server: "socks5://exit.example:1080", password: shared }), moveSealedPassword: (p: string) => { shared = p; } };
    const frames: Record<string, readonly string[]> = {};
    const gate = async (token: string, f: readonly string[]) => {
      frames[token] = f;
      if (token === ENC("X")) throw new Error("refused");
      return { value: `plain-${token.slice(7, 8)}`, label: "x" };
    };
    const lines: string[] = [];
    expect(await moveSealed({ key: KEY, gate, profiles: store, identity, log: (l) => lines.push(l) })).toEqual({ moved: 4, left: 1 });
    expect(frames).toMatchObject({ [ENC("K")]: ["https://api.vendor.example/"], [ENC("P")]: ["http://proxy.example:8080/"], [ENC("S")]: ["https://claude.ai/"], [ENC("B")]: ["http://exit.example:1080/"] });
    expect(openValue([KEY], store.apiOf("claude-code", api.id)!.key)).toBe("plain-K");
    expect(store.apiOf("claude-code", api.id)!.baseUrl).toBe("https://api.vendor.example/v1");
    expect(openValue([KEY], store.proxyOf("claude-code", sub.id)!.password!)).toBe("plain-P");
    expect(store.sessionKeyOf("claude-code", sub.id)).toMatchObject({ due: true });
    expect(openValue([KEY], store.sessionKeyOf("claude-code", sub.id)!.sealed)).toBe("plain-S");
    expect(openValue([KEY], shared)).toBe("plain-B");
    // What the gate would not open stays, and is said; a second pass moves nothing that is moved already.
    expect(store.proxyOf("codex", "default")!.password).toBe(ENC("X"));
    expect(lines.join("\n")).toContain("could not be opened");
    expect(isVaultSealed(shared)).toBe(true);
    expect(await moveSealed({ key: KEY, gate, profiles: store, identity })).toEqual({ moved: 0, left: 1 });
  });
});
