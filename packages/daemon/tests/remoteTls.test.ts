/** app-v0 §2 TLS: the self-signed certificate is made once with /usr/bin/openssl, kept 0700/0600, and its fingerprint is
 *  the SHA-256 of the DER exactly as `openssl x509 -fingerprint -sha256` computes it. */

import { execFileSync } from "node:child_process";
import { X509Certificate } from "node:crypto";
import { chmodSync, existsSync, mkdtempSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { CERT_FILE, certFingerprint, ensureTls, KEY_FILE, SYSTEM_OPENSSL } from "../src/remote/tls.js";

const mode = (path: string) => statSync(path).mode & 0o777;
const tempDir = () => join(mkdtempSync(join(tmpdir(), "agentswitch-tls-")), "remote");

describe.runIf(existsSync(SYSTEM_OPENSSL))("remote TLS certificate", () => {
  it("first start generates an EC P-256 certificate for CN=AgentSwitch valid 10 years, dir 0700, key 0600", () => {
    const dir = tempDir();
    const tls = ensureTls(dir);
    expect(mode(dir)).toBe(0o700);
    expect(mode(join(dir, KEY_FILE))).toBe(0o600);
    expect(readdirSync(dir).sort()).toEqual([CERT_FILE, KEY_FILE]);   // no temp files left behind
    const cert = new X509Certificate(tls.cert);
    expect(cert.subject).toBe("CN=AgentSwitch");
    expect(cert.issuer).toBe("CN=AgentSwitch");
    expect(cert.publicKey.asymmetricKeyType).toBe("ec");
    expect(cert.publicKey.asymmetricKeyDetails?.namedCurve).toBe("prime256v1");
    const years = (Date.parse(cert.validTo) - Date.parse(cert.validFrom)) / (365.25 * 86400_000);
    expect(years).toBeGreaterThan(9.9);
    expect(years).toBeLessThan(10.1);
    expect(cert.ca).toBe(false);
  });

  it("the fingerprint is lowercase hex SHA-256 of the DER, the same as openssl's", () => {
    const dir = tempDir();
    const tls = ensureTls(dir);
    expect(tls.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    const out = execFileSync(SYSTEM_OPENSSL, ["x509", "-in", join(dir, CERT_FILE), "-noout", "-fingerprint", "-sha256"], { encoding: "utf8" });
    const theirs = out.trim().split("=")[1]!.replace(/:/g, "").toLowerCase();
    expect(tls.fingerprint).toBe(theirs);
    expect(certFingerprint(tls.cert)).toBe(theirs);
    expect(new X509Certificate(tls.cert).fingerprint256.replace(/:/g, "").toLowerCase()).toBe(theirs);
  });

  it("later starts reuse the pair and re-tighten permissions", () => {
    const dir = tempDir();
    const first = ensureTls(dir);
    chmodSync(join(dir, KEY_FILE), 0o644);
    chmodSync(dir, 0o755);
    const second = ensureTls(dir);
    expect(second).toEqual(first);
    expect(mode(join(dir, KEY_FILE))).toBe(0o600);
    expect(mode(dir)).toBe(0o700);
  });

  it("a broken or mismatched pair is replaced with a warning", () => {
    const dir = tempDir();
    const first = ensureTls(dir);
    const other = ensureTls(tempDir());
    writeFileSync(join(dir, KEY_FILE), other.key);   // key of another certificate
    const warn = vi.fn();
    const replaced = ensureTls(dir, { warn });
    expect(replaced.fingerprint).not.toBe(first.fingerprint);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("phones must pair again"));
    writeFileSync(join(dir, CERT_FILE), "garbage");
    expect(ensureTls(dir, { warn }).fingerprint).not.toBe(replaced.fingerprint);
  });

  it("no openssl: a clear error, nothing half-written", () => {
    const dir = tempDir();
    expect(() => ensureTls(dir, { openssl: "/nonexistent/openssl" })).toThrow(/could not generate a certificate with \/nonexistent\/openssl/);
    expect(readdirSync(dir)).toEqual([]);
  });

  it("an openssl that writes nothing usable is reported", () => {
    const dir = tempDir();
    const fake = join(mkdtempSync(join(tmpdir(), "agentswitch-fakessl-")), "openssl");
    writeFileSync(fake, "#!/bin/sh\nfor a in \"$@\"; do case \"$prev\" in -out) echo junk > \"$a\";; esac; prev=\"$a\"; done\n");
    chmodSync(fake, 0o755);
    expect(() => ensureTls(dir, { openssl: fake, warn: () => undefined })).toThrow(/produced no usable certificate/);
  });
});
