/** The routes a paired phone may use (app-v0 §2 远程可用的路由), exactly as the doc lists them; the remote listener answers
 *  404 to everything else, so the MCP and skill registries, MEMORY.md and platform memory, records, routing log,
 *  approval policy, device and pairing management and the web UI never reach it. `:id` (any `:name`) is one path segment, `*` the
 *  rest. */

type Method = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

/** [method, path pattern] in the doc's order. */
export const REMOTE_ROUTES: readonly (readonly [Method, string])[] = [
  ["GET", "/healthz"],
  ["POST", "/pair"],
  ["GET", "/me"],
  // A device removing itself, and what this node is and has (docs/mesh-v0.md §2.4, §3).
  ["DELETE", "/me"],
  ["GET", "/node"],
  ["GET", "/addresses"],
  ["GET", "/gate/pubkey"],
  ["GET", "/tasks"],
  ["POST", "/tasks"],
  ["GET", "/tasks/:id"],
  ["GET", "/tasks/:id/events"],
  ["POST", "/tasks/:id/answer"],
  ["POST", "/tasks/:id/approve"],
  ["POST", "/tasks/:id/cancel"],
  ["POST", "/tasks/:id/handoff"],
  ["POST", "/tasks/:id/rate"],
  ["POST", "/tasks/:id/ack"],
  ["GET", "/search"],
  ["GET", "/tasks/:id/files"],
  ["GET", "/tasks/:id/files/*"],
  // The Files column (docs/files-v0.md §7): read only, and only while this node lets paired devices read its files,
  // inside the device's scope (`GET /settings/mesh`, `GET /devices`; both this node's own).
  ["GET", "/files"],
  ["GET", "/files/stat"],
  ["GET", "/files/preview"],
  ["GET", "/files/thumbnail"],
  ["GET", "/files/content"],
  // Changing them (docs/files-v0.md §12.5, §12.8): only while this node lets paired devices change its files too, inside
  // the device's scope; never AgentSwitch's own places or the folders holding them.
  ["POST", "/files/folder"],
  ["POST", "/files/file"],
  ["POST", "/files/rename"],
  ["POST", "/files/trash"],
  ["POST", "/files/restore"],
  ["PUT", "/files/content"],
  ["GET", "/approvals"],
  ["GET", "/threads"],
  ["GET", "/threads/:id"],
  ["PATCH", "/threads/:id"],
  ["POST", "/threads/:id/archive"],
  ["POST", "/threads/:id/reopen"],
  ["DELETE", "/tasks/:id"],
  ["DELETE", "/threads/:id"],
  ["GET", "/quota"],
  ["POST", "/quota/refresh"],
  ["GET", "/targets"],
  ["POST", "/uploads"],
  ["GET", "/context"],
  ["PUT", "/context"],
  ["GET", "/context/example"],
  ["POST", "/assistant"],
  ["GET", "/assistant"],
  ["DELETE", "/assistant/:seq"],
  ["DELETE", "/history"],
  ["GET", "/sessions"],
  ["GET", "/sessions/:harness/:id"],
  ["GET", "/sessions/:harness/:id/record"],
  ["GET", "/sessions/:harness/:id/changes"],
  ["GET", "/sessions/:harness/:id/images/:item/:n"],
  ["GET", "/sessions/:harness/:id/steps/:item/:n"],
  ["GET", "/sessions/:harness/:id/steps/:item/:n/images/:k"],
  ["GET", "/sessions/search"],
  ["DELETE", "/sessions/:harness/:id"],
  ["GET", "/terminals"],
  ["GET", "/terminals/style"],
  ["POST", "/terminals"],
  ["POST", "/terminals/resume"],
  ["GET", "/terminals/:id"],
  ["PATCH", "/terminals/:id"],
  ["GET", "/terminals/:id/stream"],
  ["GET", "/terminals/:id/commands"],
  ["POST", "/terminals/:id/input"],
  ["POST", "/terminals/:id/attach"],
  // A tool terminal beside a terminal (docs/yazi-v0.md §3): refused unless this node lets paired nodes open them.
  ["POST", "/terminals/:id/tool"],
  ["POST", "/terminals/:id/keys"],
  // Keystrokes as they are, for another node's real terminal screen; refused unless this node allows it
  // (docs/mesh-v0.md §10, `GET /settings/mesh`).
  ["POST", "/terminals/:id/write"],
  ["POST", "/terminals/:id/model"],
  ["POST", "/terminals/:id/effort"],
  ["POST", "/terminals/:id/daybreak"],
  ["POST", "/terminals/:id/choices"],
  ["GET", "/profiles"],
  ["POST", "/profiles/current"],
  // A profile's own proxy, set and asked where it lets traffic out (docs/profiles-v0.md §4.2). Making a profile,
  // removing one, signing in and its colour stay on the Mac.
  ["PUT", "/profiles/:agent/:id/proxy"],
  ["POST", "/profiles/:agent/:id/check"],
  ["POST", "/terminals/:id/mode"],
  ["GET", "/terminals/:id/files"],
  ["POST", "/terminals/:id/resize"],
  ["POST", "/terminals/:id/redraw"],
  ["POST", "/terminals/:id/permissions/:pid"],
  ["POST", "/terminals/:id/kill"],
  ["DELETE", "/terminals/:id"],
  ["GET", "/folders/git"],
  ["GET", "/browser/tabs"],
  ["POST", "/browser/tabs"],
  ["GET", "/browser/tabs/:id"],
  ["DELETE", "/browser/tabs/:id"],
  ["GET", "/browser/tabs/:id/stream"],
  ["POST", "/browser/tabs/:id/input"],
  ["POST", "/browser/tabs/:id/navigate"],
  ["POST", "/browser/tabs/:id/take"],
  ["POST", "/browser/tabs/:id/release"],
  ["POST", "/browser/tabs/:id/viewport"],
  ["POST", "/browser/tabs/:id/fill"],
  ["GET", "/browser/servers"],
  ["GET", "/browser/speed"],
  // The browsers there are, and a profile's own browser by the same routes as the shared one's (docs/profiles-v0.md
  // §5.4). Its identity and the agents' bridge are not a phone's.
  ["GET", "/browsers"],
  ["GET", "/profile-browser/:key/browser/tabs"],
  ["POST", "/profile-browser/:key/browser/tabs"],
  ["GET", "/profile-browser/:key/browser/tabs/:id"],
  ["DELETE", "/profile-browser/:key/browser/tabs/:id"],
  ["GET", "/profile-browser/:key/browser/tabs/:id/stream"],
  ["POST", "/profile-browser/:key/browser/tabs/:id/input"],
  ["POST", "/profile-browser/:key/browser/tabs/:id/navigate"],
  ["POST", "/profile-browser/:key/browser/tabs/:id/take"],
  ["POST", "/profile-browser/:key/browser/tabs/:id/release"],
  ["POST", "/profile-browser/:key/browser/tabs/:id/viewport"],
  ["POST", "/profile-browser/:key/browser/tabs/:id/fill"],
  ["GET", "/profile-browser/:key/browser/servers"],
  ["GET", "/profile-browser/:key/browser/speed"],
  // The shared browser's proxy (docs/browser-v0.md §7.6): the fingerprint is told in a line and changed on the Mac.
  ["GET", "/browser/identity"],
  ["PUT", "/browser/identity"],
  ["POST", "/browser/identity/restart"],
  // Clash Integration (docs/clash-v0.md §9). What Clash Verge and its core fetch (`/clash/sub.yaml`, `/clash/rules/…`,
  // `/clash/nodes/…`, `/clash/providers/…`) is not here: that is this Mac's loopback alone.
  ["GET", "/clash"],
  ["PUT", "/clash/settings"],
  ["GET", "/clash/templates/:name"],
  ["GET", "/clash/dns"],
  ["POST", "/clash/check"],
  ["POST", "/clash/source"],
  ["DELETE", "/clash/source"],
  ["POST", "/clash/update"],
  ["POST", "/clash/select"],
  ["POST", "/clash/delays"],
  ["GET", "/approvals/policy"],
  ["GET", "/settings/workdir"],
  ["GET", "/update"],
  ["POST", "/update/install"],
  // What is at work and what waits for the user here, as this node's own Live Activity counts it: another node's
  // screens show it beside their own (docs/mesh-v0.md §5).
  ["GET", "/live"],
];

/** Routes the remote app answers itself; every other allowed route goes on to the local API unchanged. */
export const REMOTE_OWN_ROUTES: ReadonlySet<string> = new Set(["/healthz", "/pair", "/me", "/node", "/addresses", "/gate/pubkey"]);

function compile(pattern: string): RegExp {
  const body = pattern.split("/").map((seg) => (seg.startsWith(":") ? "[^/]+" : seg === "*" ? ".+" : seg.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))).join("/");
  return new RegExp(`^${body}$`);
}

const COMPILED = REMOTE_ROUTES.map(([method, pattern]) => ({ method, re: compile(pattern) }));

/** True when `method path` is on the list. `path` is the one the router matches on (Hono's `c.req.path`). */
export function remoteAllowed(method: string, path: string): boolean {
  return COMPILED.some((r) => r.method === method && r.re.test(path));
}
