import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import WebSocket from "ws";

export async function rpcClient(endpoint) {
  const socket = new WebSocket(endpoint);
  socket.on("error", () => {});
  await once(socket, "open");
  let id = 1;
  const pending = new Map(),
    events = [];
  socket.on("message", (data) => {
    const message = JSON.parse(data.toString());
    if (message.id !== undefined) {
      const item = pending.get(message.id);
      if (!item) return;
      pending.delete(message.id);
      clearTimeout(item.timer);
      if (message.error) item.reject(new Error(message.error.message));
      else item.resolve(message.result);
    } else events.push(message);
  });
  return {
    events,
    socket,
    async close() {
      socket.terminate();
    },
    send(method, params = {}, sessionId) {
      return new Promise((resolve, reject) => {
        const next = id++,
          timer = setTimeout(() => {
            pending.delete(next);
            reject(new Error("Fixture CDP timeout: " + method));
          }, 10000);
        pending.set(next, { resolve, reject, timer });
        socket.send(
          JSON.stringify({ id: next, method, params, ...(sessionId ? { sessionId } : {}) }),
        );
      });
    },
  };
}
export async function fixtureChrome(t) {
  const dir = await mkdtemp(join(tmpdir(), "cms-owned-cdp-"));
  const candidates =
    process.platform === "win32"
      ? [
          process.env.CMS_TEST_CHROME_PATH,
          join(
            process.env.PROGRAMFILES || "C:\\Program Files",
            "Google/Chrome/Application/chrome.exe",
          ),
          join(process.env.LOCALAPPDATA || "", "Google/Chrome/Application/chrome.exe"),
        ]
      : [process.env.CMS_TEST_CHROME_PATH, "/usr/bin/google-chrome"];
  let executable;
  for (const path of candidates.filter(Boolean))
    try {
      await access(path);
      executable = path;
      break;
    } catch {}
  if (!executable) throw new Error("Fixture Chrome missing");
  const chrome = spawn(
    executable,
    [
      "--headless=new",
      "--no-sandbox",
      "--no-first-run",
      "--no-default-browser-check",
      "--remote-debugging-port=0",
      "--user-data-dir=" + dir,
      "about:blank",
    ],
    { stdio: "ignore" },
  );
  let control;
  t.after(async () => {
    await control?.close();
    chrome.kill("SIGTERM");
    await Promise.race([
      once(chrome, "exit").catch(() => {}),
      new Promise((resolve) => setTimeout(resolve, 3000)),
    ]);
    if (chrome.exitCode === null) chrome.kill("SIGKILL");
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  let portFile;
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      portFile = await readFile(join(dir, "DevToolsActivePort"), "utf8");
      break;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  if (!portFile) throw new Error("Fixture Chrome did not start");
  const [port, path] = portFile.trim().split(/\r?\n/),
    endpoint = "ws://127.0.0.1:" + port + path;
  control = await rpcClient(endpoint);
  const { targetInfos } = await control.send("Target.getTargets");
  const page = targetInfos.find((target) => target.type === "page");
  const { sessionId } = await control.send("Target.attachToTarget", {
    targetId: page.targetId,
    flatten: true,
  });
  await control.send(
    "Network.setCookie",
    {
      name: ".ASPXAUTH.Shared",
      value: "sanitized-fixture-auth",
      url: "https://som-yale.12twenty.com/",
      httpOnly: true,
      secure: true,
    },
    sessionId,
  );
  return { control, endpoint };
}
