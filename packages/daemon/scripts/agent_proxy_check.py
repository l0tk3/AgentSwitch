# Do the four agent CLIs send their own traffic through a proxy named in the environment? (docs/agents-v0.md §11)
# Each is run once with made-up keys and its own throw-away config folder, its proxy variables pointing at a listener
# here that writes down what is asked of it and refuses (502 / closes): nothing reaches a provider, no account is used.
#
#   python3 scripts/agent_proxy_check.py [seconds each, default 25]
#   CODEX_BIN=<another codex> python3 scripts/agent_proxy_check.py
#
# Not a test. Seen 2026-10-07: all four go through HTTP(S)_PROXY; with only ALL_PROXY=socks5:// Codex alone goes to it
# (and only some of its connections speak SOCKS), the other three connect directly.
import os, shutil, socket, subprocess, sys, tempfile, threading, time

def listener():
    seen = []
    srv = socket.socket(); srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    srv.bind(("127.0.0.1", 0)); srv.listen(64); srv.settimeout(0.3)
    stop = threading.Event()
    def serve():
        while not stop.is_set():
            try: conn, _ = srv.accept()
            except socket.timeout: continue
            except OSError: break
            try:
                conn.settimeout(2)
                data = conn.recv(600)
                if data[:1] == b"\x05": seen.append("SOCKS5 greeting")
                elif data.startswith(b"CONNECT "): seen.append("CONNECT " + data.split(b" ")[1].decode("latin1"))
                elif data: seen.append(data.split(b"\r\n")[0].decode("latin1")[:90])
                if data[:1] != b"\x05": conn.sendall(b"HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
            except Exception: pass
            finally: conn.close()
    t = threading.Thread(target=serve, daemon=True); t.start()
    return srv.getsockname()[1], seen, lambda: (stop.set(), srv.close())

HOME = os.path.expanduser("~")
CODEX = os.environ.get("CODEX_BIN") or "/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex"
def agents(tmp):
    work = os.path.join(tmp, "work"); os.makedirs(work, exist_ok=True)
    codex_home = os.path.join(tmp, "codex"); os.makedirs(codex_home, exist_ok=True)
    open(os.path.join(codex_home, "auth.json"), "w").write('{"OPENAI_API_KEY": "sk-made-up-for-a-proxy-check"}')
    xdg = {k: os.path.join(tmp, "oc", k) for k in ("XDG_DATA_HOME", "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "XDG_STATE_HOME")}
    pi_home = os.path.join(tmp, "pihome"); os.makedirs(pi_home, exist_ok=True)
    return work, [
        ("Claude Code", [os.path.join(HOME, ".local/bin/claude"), "-p", "hi", "--model", "haiku"], {"CLAUDE_CONFIG_DIR": os.path.join(tmp, "claude"), "ANTHROPIC_API_KEY": "sk-ant-made-up-for-a-proxy-check"}),
        ("Codex", [CODEX, "exec", "--skip-git-repo-check", "hi"], {"CODEX_HOME": codex_home}),
        ("OpenCode", [os.path.join(HOME, ".opencode/bin/opencode"), "run", "hi"], {**xdg, "ANTHROPIC_API_KEY": "sk-ant-made-up-for-a-proxy-check"}),
        ("pi", [os.path.join(HOME, ".pi/agent/bin/pi"), "-p", "hi"], {"HOME": pi_home, "ANTHROPIC_API_KEY": "sk-ant-made-up-for-a-proxy-check"}),
    ]

def run(name, argv, extra, work, proxy_env, limit):
    port, seen, close = listener()
    env = {"PATH": os.environ["PATH"], "HOME": HOME, "TERM": "dumb", "LANG": "en_US.UTF-8", "NO_PROXY": "", "no_proxy": ""}
    env.update({k: v.replace("PORT", str(port)) for k, v in proxy_env.items()})
    env.update(extra)
    began = time.time()
    try:
        p = subprocess.run(argv, cwd=work, env=env, stdin=subprocess.DEVNULL, capture_output=True, timeout=limit)
        ended = f"exit {p.returncode}"; said = (p.stderr or p.stdout).decode("utf8", "replace").strip().splitlines()[-1:] or [""]
    except subprocess.TimeoutExpired as e:
        ended = f"stopped after {limit}s"; said = ((e.stderr or e.stdout or b"").decode("utf8", "replace").strip().splitlines()[-1:] or [""])
    except FileNotFoundError:
        ended = "not installed"; said = [""]
    time.sleep(0.3); close()
    hosts = []
    for s in seen:
        if s not in hosts: hosts.append(s)
    print(f"  {name:11} {ended:18} asked the proxy for: {hosts if hosts else 'NOTHING'}   ({time.time() - began:.0f}s; it said: {said[0][:110]!r})")

tmp = tempfile.mkdtemp(prefix="as-proxy-check-")
try:
    work, list_ = agents(tmp)
    for title, penv in [("HTTP(S)_PROXY=http://127.0.0.1:…", {k: "http://127.0.0.1:PORT" for k in ("HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy")}),
                        ("ALL_PROXY=socks5://127.0.0.1:… (and no HTTP(S)_PROXY)", {"ALL_PROXY": "socks5://127.0.0.1:PORT", "all_proxy": "socks5://127.0.0.1:PORT"})]:
        print(title)
        for name, argv, extra in list_: run(name, argv, extra, work, penv, int(sys.argv[1]) if len(sys.argv) > 1 else 25)
finally:
    shutil.rmtree(tmp, ignore_errors=True)
