# AgentSwitch on Linux

A Linux machine as a node (`docs/mesh-v0.md` §4): the same service as on a Mac — terminals, Dispatch, the browser,
profiles, the remote listener for the iPhone and other nodes — without the Mac app. What the app does for the services
is done by a keeper (`agentswitch node run`, in `packages/daemon/src/keeper/`) under a systemd user service, and the
app's screens are replaced by the command line. You use it from the iPhone app and from a Mac's main window, as any
other node.

## Install

Needs x86_64 or aarch64, glibc, systemd, and to build: `curl tar rsync sha256sum make`, a C++ compiler and `python3`
(node-pty is compiled here). Nothing is installed as root, except the gate under its own account (below), which takes
one `sudo` you run yourself.

```bash
packages/linux/scripts/install.sh       # build a runtime, switch to it, install or restart the service
agentswitch gate                        # where the gate runs, and the sudo command that gives it its own account
agentswitch doctor                      # what this node has and lacks
agentswitch pair                        # a QR code for the iPhone, a link for a Mac
```

| what | where |
|---|---|
| runtime (Node 24, CPython 3.12 + secret-gate, the daemon) | `~/.local/share/agentswitch/runtime/<stamp>/`, `current` → the one in use |
| command | `~/.local/bin/agentswitch` |
| service | `~/.config/systemd/user/agentswitch.service` (runs `agentswitch node run`) |
| state | `~/.agentswitch` (daemon), `~/.secret-gate` (the gate's keys while the gate runs as you) |
| this node's settings | `~/.agentswitch/node.json` |

## The gate under its own account

Until you give it one, the gate runs as you (the keeper starts it), its keys in `~/.secret-gate` (0700): an agent of
yours that sets out to read them can. `agentswitch gate`, `agentswitch doctor` and `agentswitch config`'s Keys page say
so — "此节点的网关以你的账户运行：只防误看，不防顺手读取" — and print the command that changes it
(`docs/gate-simple-v0.md` §5). Run it once yourself; AgentSwitch never runs sudo:

```bash
sudo ~/.local/share/agentswitch/runtime/<stamp>/python/bin/secret-gate system install \
     --owner-uid $(id -u) --port 8080 --runtime ~/.local/share/agentswitch/runtime/<stamp>
```

(`agentswitch gate` prints it with this node's paths, uid and gate port filled in.) It makes the system user
`agentswitch-gate` (`useradd --system`, no home, `nologin`; Debian's `adduser` where there is no `useradd`), copies the
gate's part of your runtime (`python/`, `secret-gate/`, `VERSIONS`) as root into a root-owned directory — nothing in
your runtime is followed, every file must be yours, the same hardened copy as the Mac app's — generates a new key pair
and CA inside the service's home, and starts two systemd units. From then on the keeper starts no gate of its own (not
even when the service does not answer), hands the daemon the service's public files and port, and `secret-gate` on
this node is a client of the service.

| what | owner, mode | where |
|---|---|---|
| the service's home: key pair, CA and its key, references, logs | `agentswitch-gate`, 0700 / 0600 | `/var/lib/agentswitch/gate/` |
| public files: `keys.json`, `ca.pem`, `gate.sock` (peer uid checked with `SO_PEERCRED`: root and you) | `agentswitch-gate`, group: your primary group, 0750 | `/var/lib/agentswitch/gate-public/` |
| `ownerUid`, proxy port, runtime version (its presence is "installed") | root, 0644 | `/var/lib/agentswitch/gate-service.json` |
| the program the units run | root, 0755 / 0644 | `/opt/agentswitch/gate-runtime/` |
| units (`User=agentswitch-gate`, `NoNewPrivileges`, `ProtectSystem=strict`, `ProtectHome`, `PrivateTmp`, writes only its home and the public directory) | root, 0644 | `/etc/systemd/system/agentswitch-gate-{rpc,proxy}.service` |

```bash
sudo …/secret-gate system update --runtime ~/.local/share/agentswitch/runtime/<stamp>   # after install.sh brought a newer gate
sudo …/secret-gate system rotate-key            # a new key pair: every ciphertext made before stops working
sudo …/secret-gate system uninstall [--delete-keys]   # the account and, unless asked, the keys stay
secret-gate system status                       # no root needed
```

`install.sh` ends with `agentswitch gate`: after an update it prints `system update` when the runtime's gate is newer
than the service's. What `sudo` runs is your own runtime, which your agents could have changed: run it when you trust
it, as you trust the Mac app when typing the administrator password there (gate-simple-v0 §6). Without sudo the gate
stays as it is, as you.

Run `install.sh` again to update (one at a time; an earlier build that was stopped is removed first): the new runtime is built beside the old one, `current` is switched, the service
restarted; if the daemon does not answer within a minute, `current` goes back. The two newest runtimes are kept, and
any older one a terminal still runs on.

The terminals outlive the restart (`docs/terminal-v0.md` §10): each program is held by a small process of its own
(`pty-hold`, in a scope of its own in `agentswitch-terminals.slice`, outside the service), and the next daemon takes
it up again — the agent, its screen, its hooks and its browser tool go on. Dispatch's tasks do not outlive it: while
one is in progress the update waits, up to 30 minutes, then goes back without restarting; `install.sh --now` does not
wait. `agentswitch service stop` and `uninstall` end the terminals too; `restart` does not. `"holdTerminals": false` in
node.json turns holding off. What a terminal leaves running after it ended (`nohup … &`, a job in the
background) is ended 30 s later, and whatever an earlier service's terminals left is ended once this one has its own
terminals back (`agentswitch leftovers` lists it, `leftovers end` ends it now); `"cleanLeftovers": false` turns that off.

From a terminal that is not held (one opened before an update brought holding, or with holding off) the restart would
end the script with that terminal; it says so and leaves the restart, the check and the way back to a unit of its own
10 seconds later (`AGENTSWITCH_UPDATE_DELAY`). That terminal ends with the restart; resume the agent's conversation from
the Sessions list.

With nobody logged in systemd stops a user's services; `loginctl enable-linger $USER` keeps the node up.

The agents are your own installs and sign-ins, in their own places, found on your login shell's `PATH`:
Claude Code, Codex, OpenCode 2 (Dispatch's router runs on it, with DeepSeek), pi. `agentswitch doctor` says which are
there and signed in.

## node.json

All optional; `agentswitch node restart` (or `systemctl --user reload agentswitch`) applies a change. Ports take a
service restart.

```json
{
  "name": "workstation",
  "ports": { "local": 4711, "opencode": 4712, "remote": 4713, "gate": 8080 },
  "remote": true,
  "lan": "wg0,enp0s31f6",
  "executors": "real",
  "router": "opencode"
}
```

- `name`: what phones and other nodes call it (`agentswitch node name "…"`); else the host name.
- `lan`: the addresses a pairing offers, by interface or address, instead of the ones found. Found by default: the
  private IPv4 addresses, the default route's first, without Docker, libvirt, VMware and other virtual interfaces;
  overlay addresses (100.64/10: Tailscale, NetBird) as the second kind.
- `router: "echo"`: Dispatch without its model (no OpenCode needed); `executors: "echo"`: no real agents, for trying out.

## Reaching it

The remote listener (4713) only answers private, link-local and overlay addresses (`10/8`, `172.16/12`,
`192.168/16`, `100.64/10`, IPv6 ULA): a WireGuard, Tailscale or NetBird network, or the LAN. A machine with only a
public address is reached over one of those, or through `ssh -L 4713:127.0.0.1:4713`.

## Commands

Besides everything the daemon's CLI has (`task`, `tasks`, `watch`, `approve`, `pair`, `devices`, `nodes`, `--on`, …):

| command | |
|---|---|
| `agentswitch node` | name, kind, port, fingerprint, the addresses offered |
| `agentswitch node name "<name>"` | name this node |
| `agentswitch node restart` | restart the daemon with node.json as it is now |
| `agentswitch node run` | the keeper in the foreground (what the service runs; for a container or tmux) |
| `agentswitch service install \| uninstall \| status \| start \| stop \| restart \| logs` | the systemd user service |
| `agentswitch doctor` | runtime, service, the gate's account, agents and their sign-ins, tools |
| `agentswitch gate [--json]` | where the gate runs, and the exact `sudo … system install \| update \| rotate-key` to run (never run by it) |
| `agentswitch profiles` | the agents' profiles, as the Mac's Settings › Agents: `new <agent> "<name>"` (an account; `--api [--base-url u] [--model m]` pays by a key), `api <agent> <profile>` (address, model, `--key` a new key), `color`, `rm`. A key is asked for with nothing echoed (or piped in) and sealed by this node's gate for the address's site; only the ciphertext reaches the service |
| `agentswitch config [page] [--lang l]` | this node's settings on a full screen, as the Mac's Settings window (docs/tui-v0.md): Agents (profiles; a key-paying one's vendor, address, model chosen from what the address lists, key, connection test; proxy, session key, telemetry, colour), Models (saved, the service restarted), Permissions, Keys (the gate's key pairs), Node (name, pairing, held terminals, ports, language, the work folder), Environment (doctor), Context (CONTEXT.md and MEMORY.md in `$EDITOR`, what dispatch learned), Extensions (MCP servers, skills). English, 简体中文, 繁體中文, 日本語, Español: `--lang`, else `AGENTSWITCH_LANG`, else the one kept in node.json (L on the screen), else the locale. With `--on <node>`, another node's, read only |
| `agentswitch console [--open]` | a one-time link into the web console on this machine |
| `agentswitch engine update --camoufox latest` | the shared browser's engine (needs `unzip` and Firefox's libraries) |

## Uninstall

```bash
sudo …/secret-gate system uninstall --delete-keys   # first, with the gate service: its units, runtime copy and keys
sudo userdel agentswitch-gate; sudo rm -rf /var/lib/agentswitch /opt/agentswitch   # and its account, if wanted
agentswitch service uninstall
rm -rf ~/.local/share/agentswitch ~/.local/bin/agentswitch
# state, if you want it gone too: ~/.agentswitch ~/.secret-gate
```

The agents' own folders (`~/.claude`, `~/.codex`, `~/.local/share/opencode`, `~/.pi`) are never touched.

## Not yet

From `docs/mesh-v0.md` §9 A: `attach` (a service-held terminal in this terminal), and the iPhone's wording for a node
that is not a Mac.

## Build only

```bash
packages/linux/scripts/build-runtime.sh <out>   # a runtime in <out>, no install
packages/linux/scripts/lock-python.sh           # regenerate python-requirements-<arch>.txt (needs uv)
packages/linux/scripts/smoke.sh <runtime>       # start it once as a throw-away node (own home, ports 24711–24714),
                                                # check that the daemon answers and doctor finds keeper, gate, daemon
```

CI (`.github/workflows/ci.yml`) builds both architectures' runtimes, runs `smoke.sh` on each and keeps them as the
run's artifacts.
