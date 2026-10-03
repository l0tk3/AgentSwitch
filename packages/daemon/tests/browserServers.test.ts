/** The local servers a new tab offers (docs/browser-v0.md §2 本地开发服务), from fixture `lsof` and `ps` output: loopback
 *  and every-interface listeners run from the user's folders, without the apps' own ports or AgentSwitch's. */

import { describe, expect, it } from "vitest";
import { appFolder, listLocalServers, localServers, parseCommands, parseCwds, parseListeners, serverName, type Run } from "../src/browser/servers.js";

const HOME = "/Users/me";
const DAEMON = 900;

// `lsof -nP -a -u 501 -iTCP -sTCP:LISTEN -F pcRn`, as this Mac prints it.
const LISTEN = [
  "p676", "R1", "cWeChat", "f246", "n127.0.0.1:14013",
  "p771", "R1", "cControlCenter", "f9", "n*:7000", "f10", "n*:5000",
  "p714", "R1", "cclash-verge", "f14", "n127.0.0.1:33331",
  "p900", "R899", "cnode", "f20", "n127.0.0.1:4711", "f21", "n*:4713",
  "p901", "R900", "copencode", "f5", "n127.0.0.1:4722",
  "p950", "R900", "copencode", "f5", "n127.0.0.1:61234",
  "p1200", "R1180", "cnode", "f23", "n[::1]:5173", "f24", "n127.0.0.1:5173",
  "p1300", "R1290", "cnext-server (v15.1.0)", "f30", "n*:3000",
  "p1400", "R1390", "cPython", "f3", "n127.0.0.1:8000",
  "p1500", "R1", "cpython3.12", "f4", "n127.0.0.1:8080",
  "p1600", "R1590", "cnode", "f4", "n192.168.1.5:9000",
  "p1700", "R1690", "cnode", "f4", "n127.0.0.1:4000",
  "garbage", "n", "",
].join("\n");
const CWDS = [
  "p676", "fcwd", "n/Users/me/Library/Containers/com.tencent.xinWeChat/Data",
  "p771", "fcwd", "n/",
  "p714", "fcwd", "n/",
  "p900", "fcwd", "n/Users/me/Library/Application Support/AgentSwitch",
  "p901", "fcwd", "n/Users/me/Library/Application Support/AgentSwitch/opencode",
  "p950", "fcwd", "n/Users/me/Projects/app",
  "p1200", "fcwd", "n/Users/me/Projects/site",
  "p1300", "fcwd", "n/Users/me/Projects/web",
  "p1400", "fcwd", "n/Users/me/Downloads/report",
  "p1500", "fcwd", "n/Users/me",
  "p1600", "fcwd", "n/Users/me/Projects/lan",
  "p1700", "fcwd", "n/Users/me/Projects/other",
].join("\n");
const PS = [
  "  676 /Applications/WeChat.app/Contents/MacOS/WeChat",
  "  900 /Applications/AgentSwitch.app/Contents/Resources/runtime/node/bin/node dist/cli.js serve",
  "  950 /Users/me/.opencode/bin/opencode serve --stdio --port 0 --hostname 127.0.0.1",
  " 1200 node /Users/me/Projects/site/node_modules/.bin/vite --port 5173",
  " 1300 next-server (v15.1.0)",
  " 1400 /opt/homebrew/bin/python3 -m http.server 8000",
  " 1500 /Users/me/.secret-gate/venv/bin/python3.12 -m secret_gate.cli proxy --port 8080",
  " 1700 node /Users/me/Projects/other/server.js",
].join("\n");

describe("parsing", () => {
  it("listeners, folders and command lines", () => {
    const listeners = parseListeners(LISTEN);
    expect(listeners).toContainEqual({ pid: 1200, ppid: 1180, command: "node", host: "::1", port: 5173 });
    expect(listeners).toContainEqual({ pid: 771, ppid: 1, command: "ControlCenter", host: "*", port: 7000 });
    expect(listeners.filter((l) => l.pid === 900).map((l) => l.port)).toEqual([4711, 4713]);
    expect(parseCwds(CWDS).get(1200)).toBe("/Users/me/Projects/site");
    expect(parseCommands(PS).get(1400)).toBe("/opt/homebrew/bin/python3 -m http.server 8000");
  });

  it("a short name for the program", () => {
    expect(serverName("node /Users/me/Projects/site/node_modules/.bin/vite --port 5173", "node")).toBe("vite");
    expect(serverName("node --inspect server.js", "node")).toBe("server");
    expect(serverName("/opt/homebrew/bin/python3 -m http.server 8000", "Python")).toBe("python3 -m http.server");
    expect(serverName("ruby bin/rails server", "ruby")).toBe("rails");
    expect(serverName("/Library/Frameworks/Python3.framework/Resources/Python.app/Contents/MacOS/Python -m http.server 8000", "Python")).toBe("Python -m http.server");
    expect(serverName("next-server (v15.1.0)", "next-server (v15.1.0)")).toBe("next-server (v15.1.0)");
    expect(serverName("/usr/local/bin/caddy run", "caddy")).toBe("caddy");
    expect(serverName("node", "node")).toBe("node");
    expect(serverName("", "deno")).toBe("deno");
    expect(serverName("python3 manage.py runserver 8000", "Python")).toBe("manage");
    expect(serverName("java -jar build/app.jar", "java")).toBe("app");
    expect(serverName("deno run -A main.ts", "deno")).toBe("main");
  });

  // 2026-10-02 review: the first word after the flags could be a flag's value.
  it("never another word of the command line: a flag's value is not a name", () => {
    for (const [command, name] of [
      ["node --token sk-live-abc123 server.js", "server"],
      ["node --api-key sk-live-abc123", "node"],
      ["node -r dotenv/config --secret hunter2 ./dist/index.mjs", "index"],
      ["python3 --password hunter2", "python3"],
      ["python3 -m 'import os; leak'", "python3"],
      ["python3 -m hunter2.secret.token", "python3 -m hunter2.secret.token"],   // a module name, the program's own
      ["ruby -e puts('hunter2')", "ruby"],
      ["bun run dev --key=hunter2", "bun"],
      ["php -S localhost:8000 -t public", "php"],
      ["node /x/node_modules/.bin/vite --password hunter2", "vite"],
    ] as const) {
      const shown = serverName(command, command.split(" ")[0]!);
      expect(shown, command).toBe(name);
      if (!name.includes("hunter2")) expect(shown).not.toContain("hunter2");
      expect(shown).not.toContain("sk-live");
    }
  });

  it("app folders", () => {
    for (const f of ["/", "/Users/me/Library/Containers/x/Data", "/Applications/Lark.app/Contents/Frameworks", "/System/Library", "/usr/local"]) expect(appFolder(f, HOME), f).toBe(true);
    for (const f of ["/Users/me", "/Users/me/Projects/site", "/tmp/x", "/Volumes/work/app"]) expect(appFolder(f, HOME), f).toBe(false);
  });
});

describe("the list", () => {
  it("the user's servers, one per port, without the apps' or AgentSwitch's own", () => {
    const servers = localServers(parseListeners(LISTEN), parseCwds(CWDS), parseCommands(PS), { ports: [4711, 4713, 4722, 8080], pid: DAEMON, home: HOME });
    expect(servers).toEqual([
      { port: 3000, bind: "all", pid: 1300, name: "next-server (v15.1.0)", cwd: "/Users/me/Projects/web", url: "http://localhost:3000/" },
      { port: 4000, bind: "loopback", pid: 1700, name: "server", cwd: "/Users/me/Projects/other", url: "http://localhost:4000/" },
      { port: 5173, bind: "loopback", pid: 1200, name: "vite", cwd: "/Users/me/Projects/site", url: "http://localhost:5173/" },
      { port: 8000, bind: "loopback", pid: 1400, name: "python3 -m http.server", cwd: "/Users/me/Downloads/report", url: "http://localhost:8000/" },
    ]);
  });

  it("leaves out the gate's proxy and the harness's OpenCode by their command line, whatever their port", () => {
    const listeners = parseListeners(["p1500", "R1", "cpython3.12", "n127.0.0.1:18080", "p950", "R42", "copencode", "n127.0.0.1:61234", "p2", "R1", "cnode", "n127.0.0.1:7777"].join("\n"));
    const cwds = new Map([[1500, "/Users/me"], [950, "/Users/me/p"], [2, "/Users/me/AgentSwitch.app/Contents/Resources"]]);
    expect(localServers(listeners, cwds, parseCommands(PS), { ports: [], pid: DAEMON, home: HOME })).toEqual([]);
  });

  it("asks lsof for this user's listening TCP sockets, then their folders and commands", async () => {
    const calls: string[][] = [];
    const exec: Run = async (file, args) => {
      calls.push([file, ...args]);
      if (file === "ps") return PS;
      return args.includes("cwd") ? CWDS : LISTEN;
    };
    const servers = await listLocalServers({ ports: [4711, 4713, 4722, 8080], pid: DAEMON, home: HOME }, exec, 501);
    expect(servers.map((s) => s.port)).toEqual([3000, 4000, 5173, 8000]);
    expect(calls[0]).toEqual(["lsof", "-nP", "-a", "-u", "501", "-iTCP", "-sTCP:LISTEN", "-F", "pcRn"]);
    expect(calls[1]![0]).toBe("lsof");
    expect(calls[1]).toContain("cwd");
    expect(calls[2]!.slice(0, 3)).toEqual(["ps", "-o", "pid=,command="]);
  });

  it("nothing listening: one call, no list; a failing folder or command lookup leaves those servers out", async () => {
    const calls: string[] = [];
    expect(await listLocalServers({ ports: [], pid: DAEMON, home: HOME }, async (f) => { calls.push(f); return ""; }, 501)).toEqual([]);
    expect(calls).toEqual(["lsof"]);
    const failing: Run = async (file, args) => {
      if (file === "lsof" && !args.includes("cwd")) return LISTEN;
      throw new Error("lsof failed");
    };
    expect(await listLocalServers({ ports: [], pid: DAEMON, home: HOME }, failing, 501)).toEqual([]);
  });
});
