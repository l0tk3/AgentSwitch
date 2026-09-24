/** The remote listener's self-signed certificate (app-v0 §2 TLS): generated once with /usr/bin/openssl (EC P-256,
 *  CN=AgentSwitch, 10 years) into $AGENTSWITCH_HOME/remote/{cert.pem,key.pem}, directory 0700 and key 0600. Phones
 *  trust only the fingerprint they got at pairing: SHA-256 of the certificate's DER, lowercase hex. */

import { execFileSync } from "node:child_process";
import { createHash, createPrivateKey, X509Certificate } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";

export const SYSTEM_OPENSSL = "/usr/bin/openssl";
export const CERT_FILE = "cert.pem";
export const KEY_FILE = "key.pem";
const CERT_DAYS = 3650;
const OPENSSL_TIMEOUT_MS = 15_000;
const DIR_MODE = 0o700;
const KEY_MODE = 0o600;
const CERT_MODE = 0o644;

export type TlsMaterial = { readonly cert: string; readonly key: string; readonly fingerprint: string };

/** SHA-256 of the certificate's DER encoding, lowercase hex without separators. */
export function certFingerprint(certPem: string): string {
  return createHash("sha256").update(new X509Certificate(certPem).raw).digest("hex");
}

/** The pair on disk when it parses and the key belongs to the certificate; null otherwise. */
function readPair(dir: string): TlsMaterial | null {
  const certPath = join(dir, CERT_FILE);
  const keyPath = join(dir, KEY_FILE);
  if (!existsSync(certPath) || !existsSync(keyPath)) return null;
  try {
    const cert = readFileSync(certPath, "utf8");
    const key = readFileSync(keyPath, "utf8");
    if (!new X509Certificate(cert).checkPrivateKey(createPrivateKey(key))) return null;
    return { cert, key, fingerprint: certFingerprint(cert) };
  } catch {
    return null;
  }
}

/** Key then certificate into temporary names, permissions set before either is moved into place. */
function generate(dir: string, openssl: string): void {
  const tmpKey = join(dir, `.${KEY_FILE}.${process.pid}`);
  const tmpCert = join(dir, `.${CERT_FILE}.${process.pid}`);
  const run = (args: string[]) => execFileSync(openssl, args, { stdio: ["ignore", "ignore", "pipe"], timeout: OPENSSL_TIMEOUT_MS });
  try {
    run(["ecparam", "-name", "prime256v1", "-genkey", "-noout", "-out", tmpKey]);
    chmodSync(tmpKey, KEY_MODE);
    run(["req", "-new", "-x509", "-key", tmpKey, "-out", tmpCert, "-days", String(CERT_DAYS), "-sha256", "-subj", "/CN=AgentSwitch",
      "-addext", "basicConstraints=critical,CA:FALSE", "-addext", "keyUsage=critical,digitalSignature", "-addext", "extendedKeyUsage=serverAuth"]);
    chmodSync(tmpCert, CERT_MODE);
    renameSync(tmpKey, join(dir, KEY_FILE));
    renameSync(tmpCert, join(dir, CERT_FILE));
  } finally {
    rmSync(tmpKey, { force: true });
    rmSync(tmpCert, { force: true });
  }
}

/** The certificate and key under `dir`, generated on first use. A pair that does not parse or does not match is
 *  replaced with a warning (paired phones must pair again: their pinned fingerprint is gone). Permissions are
 *  re-tightened on every start. */
export function ensureTls(dir: string, opts: { readonly openssl?: string; readonly warn?: (message: string) => void } = {}): TlsMaterial {
  const openssl = opts.openssl ?? SYSTEM_OPENSSL;
  mkdirSync(dir, { recursive: true, mode: DIR_MODE });
  chmodSync(dir, DIR_MODE);
  let pair = readPair(dir);
  if (!pair) {
    if (existsSync(join(dir, CERT_FILE)) || existsSync(join(dir, KEY_FILE))) (opts.warn ?? console.error)(`remote TLS: ${dir} holds an unusable certificate or key; generating a new pair (phones must pair again)`);
    try { generate(dir, openssl); }
    catch (err) { throw new Error(`remote TLS: could not generate a certificate with ${openssl}: ${(err as Error).message}`); }
    pair = readPair(dir);
    if (!pair) throw new Error(`remote TLS: ${openssl} produced no usable certificate in ${dir}`);
  }
  chmodSync(join(dir, KEY_FILE), KEY_MODE);
  return pair;
}
