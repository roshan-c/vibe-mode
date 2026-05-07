import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { spawn, type ChildProcess } from "node:child_process";
import { createConnection } from "node:net";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

const DEFAULT_URL = "https://www.youtube.com/watch?v=7MLRfIoSbdY&list=RD7MLRfIoSbdY&start_radio=1";
const STORE_PATH = join(homedir(), ".pi", "agent", "vibe-mode.json");

type Station = {
  id: string;
  title: string;
  subtitle: string;
  url: string;
  startSeconds?: number;
};

type Config = {
  enabled: boolean;
  station: string;
  stations: Station[];
  player: string;
  volume: number;
  idleVolumeRatio: number;
  fadeMs: number;
  ytdlFormat: string;
  startMinSeconds: number;
  startMaxSeconds: number;
  preResolve: boolean;
  prewarm: boolean;
  resolveTTLSeconds: number;
  resolveTimeoutMs: number;
};

type PlayerHandle = {
  child: ChildProcess;
  socket: string;
  stationID: string;
  source: string;
};

type Timer = ReturnType<typeof setTimeout>;

const DEFAULT_STATIONS: Station[] = [
  { id: "house", title: "House", subtitle: "four-on-floor flow", url: DEFAULT_URL, startSeconds: 412 },
  {
    id: "lofi",
    title: "Lo-Fi",
    subtitle: "soft-focus loops",
    url: "https://www.youtube.com/watch?v=1J4a9cT2lkw&list=RD1J4a9cT2lkw&start_radio=1",
  },
  {
    id: "jazz",
    title: "Jazz",
    subtitle: "after-hours debugging",
    url: "https://www.youtube.com/watch?v=oL0eR16-tRs&list=RDoL0eR16-tRs&start_radio=1",
  },
];

const DEFAULT_CONFIG: Config = {
  enabled: true,
  station: "house",
  stations: DEFAULT_STATIONS,
  player: "mpv",
  volume: 45,
  idleVolumeRatio: 0.6,
  fadeMs: 1800,
  ytdlFormat: "bestaudio",
  startMinSeconds: 300,
  startMaxSeconds: 600,
  preResolve: true,
  prewarm: true,
  resolveTTLSeconds: 1800,
  resolveTimeoutMs: 15000,
};

function clamp(value: unknown, fallback: number, min: number, max: number) {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(min, Math.min(max, value)) : fallback;
}

function readConfig(): Config {
  try {
    const raw = JSON.parse(readFileSync(STORE_PATH, "utf8")) as Partial<Config>;
    return {
      ...DEFAULT_CONFIG,
      ...raw,
      stations: Array.isArray(raw.stations) && raw.stations.length ? raw.stations : DEFAULT_STATIONS,
      volume: clamp(raw.volume, DEFAULT_CONFIG.volume, 0, 100),
      idleVolumeRatio: clamp(raw.idleVolumeRatio, DEFAULT_CONFIG.idleVolumeRatio, 0, 1),
      fadeMs: clamp(raw.fadeMs, DEFAULT_CONFIG.fadeMs, 0, 10000),
    };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

function saveConfig(config: Config) {
  mkdirSync(dirname(STORE_PATH), { recursive: true });
  writeFileSync(STORE_PATH, `${JSON.stringify(config, null, 2)}\n`);
}

function unref(timer: Timer) {
  (timer as { unref?: () => void }).unref?.();
}

function ipcPath() {
  return `/tmp/pi-vibe-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.sock`;
}

export default function vibeMode(pi: ExtensionAPI) {
  let config = readConfig();
  let player: PlayerHandle | undefined;
  let standby: PlayerHandle | undefined;
  let currentVolume = 0;
  let fadeTimer: Timer | undefined;
  let fadeToken = 0;
  let prewarmToken = 0;
  let desired = false;
  let active = false;
  let restartBlocked = false;
  let lastContext: ExtensionContext | undefined;
  let lastProblem: string | undefined;
  const resolved = new Map<string, { url: string; expires: number }>();
  const resolving = new Map<string, Promise<string>>();

  const stationIndex = () => {
    const hit = config.stations.findIndex((item) => item.id === config.station);
    return hit >= 0 ? hit : 0;
  };
  const station = () => config.stations[stationIndex()] ?? config.stations[0]!;
  const nextStationItem = () => config.stations[(stationIndex() + 1) % config.stations.length];
  const idleVolume = () => Math.round(config.volume * config.idleVolumeRatio);
  const targetVolume = () => (active ? config.volume : idleVolume());

  function setStatus(ctx = lastContext) {
    if (!ctx) return;
    const suffix = lastProblem ? `error: ${lastProblem.slice(0, 36)}` : `${station().title}${active ? " ↑" : ""}`;
    ctx.ui.setStatus("vibe-mode", config.enabled ? `♫ ${suffix}` : undefined);
  }

  function notify(message: string, type: "info" | "warning" | "error" = "info", ctx = lastContext) {
    ctx?.ui.notify(message, type);
  }

  function showProblem(message: string) {
    lastProblem = message;
    restartBlocked = true;
    setStatus();
    notify(`Vibe mode: ${message}`, "error");
  }

  function stationStartSeconds(item: Station) {
    if (typeof item.startSeconds === "number") return item.startSeconds;
    const min = Math.min(config.startMinSeconds, config.startMaxSeconds);
    const max = Math.max(config.startMinSeconds, config.startMaxSeconds);
    return max <= 0 ? 0 : Math.floor(min + Math.random() * (max - min + 1));
  }

  function clearFade() {
    fadeToken += 1;
    if (fadeTimer) clearTimeout(fadeTimer);
    fadeTimer = undefined;
  }

  function sendMpv(command: unknown[], socket = player?.socket) {
    if (!socket) return Promise.resolve(false);
    return new Promise<boolean>((resolve) => {
      const conn = createConnection(socket);
      const timeout = setTimeout(() => finish(false), 250);
      unref(timeout);
      let done = false;
      const finish = (ok: boolean) => {
        if (done) return;
        done = true;
        clearTimeout(timeout);
        conn.destroy();
        resolve(ok);
      };
      conn.once("connect", () => conn.write(`${JSON.stringify({ command })}\n`, () => finish(true)));
      conn.once("error", () => finish(false));
    });
  }

  function quitHandle(handle: PlayerHandle | undefined) {
    if (!handle) return;
    void sendMpv(["quit"], handle.socket);
    const timer = setTimeout(() => {
      if (!handle.child.killed) handle.child.kill("SIGTERM");
    }, 300);
    unref(timer);
  }

  function terminatePlayer() {
    const handle = player;
    player = undefined;
    currentVolume = 0;
    clearFade();
    quitHandle(handle);
  }

  function terminateStandby() {
    const handle = standby;
    standby = undefined;
    quitHandle(handle);
  }

  function fadeTo(target: number, after?: () => void) {
    clearFade();
    const token = fadeToken;
    const start = currentVolume;
    const startAt = Date.now();
    if (config.fadeMs === 0) {
      currentVolume = target;
      void sendMpv(["set_property", "volume", Math.round(target)]);
      after?.();
      return;
    }
    const step = () => {
      if (token !== fadeToken) return;
      const amount = Math.min(1, (Date.now() - startAt) / config.fadeMs);
      currentVolume = start + (target - start) * amount;
      void sendMpv(["set_property", "volume", Math.round(currentVolume)]);
      if (amount >= 1) return after?.();
      fadeTimer = setTimeout(step, 100);
      unref(fadeTimer);
    };
    step();
  }

  function resolveStationUrl(item: Station) {
    if (!config.preResolve) return Promise.resolve(item.url);
    const cached = resolved.get(item.id);
    if (cached && cached.expires > Date.now()) return Promise.resolve(cached.url);
    const existing = resolving.get(item.id);
    if (existing) return existing;
    const task = new Promise<string>((resolve) => {
      let stdout = "";
      let done = false;
      const child = spawn("yt-dlp", ["-g", "-f", config.ytdlFormat, "--no-playlist", item.url], { stdio: ["ignore", "pipe", "ignore"] });
      const timer = setTimeout(() => finish(item.url), config.resolveTimeoutMs);
      unref(timer);
      const finish = (url: string) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolving.delete(item.id);
        if (!child.killed) child.kill("SIGTERM");
        if (url !== item.url) resolved.set(item.id, { url, expires: Date.now() + config.resolveTTLSeconds * 1000 });
        resolve(url);
      };
      child.stdout?.on("data", (chunk) => (stdout += String(chunk)));
      child.once("error", () => finish(item.url));
      child.once("exit", () => {
        const direct = stdout.split(/\r?\n/).map((line) => line.trim()).find((line) => line.startsWith("http://") || line.startsWith("https://"));
        finish(direct ?? item.url);
      });
    });
    resolving.set(item.id, task);
    return task;
  }

  function spawnPlayer(input: { item: Station; source: string; volume: number; role: "active" | "standby" }) {
    const socket = ipcPath();
    const child = spawn(
      config.player,
      [
        "--no-video",
        "--force-window=no",
        "--input-terminal=no",
        `--input-ipc-server=${socket}`,
        `--volume=${input.volume}`,
        "--loop-playlist=inf",
        `--ytdl-format=${config.ytdlFormat}`,
        `--start=${stationStartSeconds(input.item)}`,
        "--msg-level=all=warn",
        input.source,
      ],
      { stdio: ["ignore", "ignore", "pipe"] },
    );
    const handle: PlayerHandle = { child, socket, stationID: input.item.id, source: input.source };
    let stderr = "";
    child.stderr?.on("data", (chunk) => (stderr = `${stderr}${String(chunk)}`.split(/\r?\n/).slice(-4).join("\n")));
    child.once("error", (error) => {
      if (input.role === "active" && player === handle) player = undefined;
      if (input.role === "standby" && standby === handle) standby = undefined;
      if (input.role === "active") showProblem(`Unable to start ${config.player}: ${error.message}`);
    });
    child.once("exit", (code) => {
      if (input.role === "standby") {
        if (standby === handle) standby = undefined;
        return;
      }
      if (player !== handle) return;
      player = undefined;
      currentVolume = 0;
      if (!desired) return setStatus();
      if (code === 0) {
        const timer = setTimeout(() => void startPlayer(), 500);
        unref(timer);
        return;
      }
      showProblem(stderr.trim() || `${config.player} exited with code ${code ?? "unknown"}`);
    });
    return handle;
  }

  async function startPlayer() {
    if (player || restartBlocked || !config.enabled) return;
    lastProblem = undefined;
    const item = station();
    const source = await resolveStationUrl(item);
    if (player || restartBlocked || !desired || station().id !== item.id) return;
    player = spawnPlayer({ item, source, volume: 0, role: "active" });
    fadeTo(targetVolume(), setStatus);
    void prewarmNext();
    setStatus();
  }

  async function prewarmNext() {
    const token = ++prewarmToken;
    if (!config.prewarm || !config.enabled || config.stations.length < 2) return terminateStandby();
    const item = nextStationItem();
    if (!item || item.id === station().id || standby?.stationID === item.id) return;
    terminateStandby();
    const source = await resolveStationUrl(item);
    if (token !== prewarmToken || !config.enabled || item.id === station().id) return;
    standby = spawnPlayer({ item, source, volume: 0, role: "standby" });
  }

  function applyDesired() {
    desired = config.enabled;
    if (desired) {
      void startPlayer();
      if (player) fadeTo(targetVolume(), setStatus);
    } else {
      if (player) fadeTo(0, terminatePlayer);
      terminateStandby();
    }
    setStatus();
  }

  async function loadStation(item: Station) {
    if (standby?.stationID === item.id) {
      const previous = player;
      player = standby;
      standby = undefined;
      currentVolume = targetVolume();
      void sendMpv(["set_property", "volume", Math.round(currentVolume)]);
      quitHandle(previous);
      void prewarmNext();
      return setStatus();
    }
    if (!player) return void startPlayer();
    const source = await resolveStationUrl(item);
    const ok = await sendMpv(["loadfile", source, "replace", -1, `start=${stationStartSeconds(item)}`]);
    if (!ok) {
      terminatePlayer();
      if (config.enabled) void startPlayer();
    }
    fadeTo(targetVolume(), setStatus);
    void prewarmNext();
  }

  function setStation(id: string) {
    const item = config.stations.find((entry) => entry.id === id);
    if (!item) return false;
    config.station = item.id;
    saveConfig(config);
    restartBlocked = false;
    lastProblem = undefined;
    if (config.enabled) void loadStation(item);
    setStatus();
    return true;
  }

  function nextStation() {
    const next = config.stations[(stationIndex() + 1) % config.stations.length];
    if (next) setStation(next.id);
  }

  function previousStation() {
    const next = config.stations[(stationIndex() - 1 + config.stations.length) % config.stations.length];
    if (next) setStation(next.id);
  }

  pi.on("session_start", async (_event, ctx) => {
    lastContext = ctx;
    active = false;
    applyDesired();
    for (const item of config.stations) void resolveStationUrl(item);
  });

  pi.on("agent_start", async (_event, ctx) => {
    lastContext = ctx;
    active = true;
    applyDesired();
  });

  pi.on("agent_end", async (_event, ctx) => {
    lastContext = ctx;
    active = false;
    applyDesired();
  });

  pi.on("session_shutdown", async () => {
    desired = false;
    active = false;
    terminatePlayer();
    terminateStandby();
  });

  pi.registerCommand("vibe", {
    description: "Toggle background focus music",
    handler: async (_args, ctx) => {
      lastContext = ctx;
      config.enabled = !config.enabled;
      if (config.enabled) restartBlocked = false;
      saveConfig(config);
      applyDesired();
      notify(config.enabled ? "Vibe mode enabled" : "Vibe mode disabled", "info", ctx);
    },
  });

  pi.registerCommand("vibe-restart", {
    description: "Restart vibe mode player",
    handler: async (_args, ctx) => {
      lastContext = ctx;
      restartBlocked = false;
      lastProblem = undefined;
      terminatePlayer();
      applyDesired();
      notify("Vibe player restarted", "info", ctx);
    },
  });

  pi.registerCommand("vibe-next", {
    description: "Switch to the next vibe station",
    handler: async (_args, ctx) => {
      lastContext = ctx;
      nextStation();
      notify(`Current vibe: ${station().title}`, "info", ctx);
    },
  });

  pi.registerCommand("vibe-prev", {
    description: "Switch to the previous vibe station",
    handler: async (_args, ctx) => {
      lastContext = ctx;
      previousStation();
      notify(`Current vibe: ${station().title}`, "info", ctx);
    },
  });

  pi.registerCommand("vibe-status", {
    description: "Show vibe mode status and config path",
    handler: async (_args, ctx) => {
      lastContext = ctx;
      setStatus(ctx);
      notify(`Vibe ${config.enabled ? "on" : "off"}: ${station().title}. Config: ${STORE_PATH}`, "info", ctx);
    },
  });
}
