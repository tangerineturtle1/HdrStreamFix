/*
 * HdrStreamFix — main-process side.
 *
 * 1. HDR capture: runs the C# helper (capture.ts) as a long-lived PowerShell process that captures
 *    the real 16-bit HDR screen or window, tone-maps it on the GPU and streams BGRA frames to us.
 *    The renderer long-polls getFrame() and feeds them into the Discord stream. Windows HDR stays on.
 * 2. HDR videos: switches HDR on for Vesktop's monitor while an HDR video plays, then restores your
 *    original setting. Original states live here so reloads/quits never strand a monitor.
 */

import { ChildProcessWithoutNullStreams, execFile, execFileSync, spawn } from "child_process";
import { app, BrowserWindow, desktopCapturer, ipcMain, IpcMainInvokeEvent, screen } from "electron";
import { existsSync, mkdirSync, writeFileSync } from "fs";
import { join } from "path";

import { AUDIO_CS } from "./audio";
import { CAPTURE_CS } from "./capture";
import { CSHARP_USINGS, DISPLAYS_CS, HELPER_VERSION } from "./displayConfig";
import { Frame, FrameParser } from "./frameParser";
import { CaptureOptions, CaptureTarget, OutputInfo, pickOutput } from "./pickOutput";

export type { CaptureOptions, CaptureTarget, OutputInfo };

export type HdrMode = "none" | "video";

export interface DisplayHdrInfo {
    name: string;
    adapterLow: number;
    adapterHigh: number;
    targetId: number;
    supported: boolean;
    on: boolean;
    sdrWhiteNits: number;
}

const IS_WIN = process.platform === "win32";

// ======================= PowerShell plumbing =======================

function helperPaths() {
    const dir = join(app.getPath("userData"), "HdrStreamFix");
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const cs = join(dir, `HdrHelper-v${HELPER_VERSION}.cs`);
    const dll = join(dir, `HdrHelper-v${HELPER_VERSION}.dll`);
    if (!existsSync(cs)) writeFileSync(cs, CSHARP_USINGS + DISPLAYS_CS + CAPTURE_CS + AUDIO_CS, "utf8");
    return { cs, dll };
}

const psLiteral = (s: string) => "'" + s.replace(/'/g, "''") + "'";

function psArgs(body: string) {
    const { cs, dll } = helperPaths();
    const script = [
        "$ErrorActionPreference = 'Stop'; $ProgressPreference = 'SilentlyContinue'",
        `$cs = ${psLiteral(cs)}; $dll = ${psLiteral(dll)}`,
        "if (-not (Test-Path $dll)) { Add-Type -Path $cs -OutputAssembly $dll -OutputType Library }",
        "Add-Type -Path $dll",
        body
    ].join("\n");
    return ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")];
}

function runPs(body: string): Promise<string> {
    return new Promise((resolve, reject) => {
        execFile("powershell.exe", psArgs(body), { windowsHide: true, timeout: 30000 }, (err, stdout, stderr) => {
            if (err) reject(new Error((stderr || err.message).trim()));
            else resolve(stdout.trim());
        });
    });
}

const num = (n: number) => (Number.isFinite(n) ? n : 0).toString();

// ======================= HDR screen capture =======================

let proc: ChildProcessWithoutNullStreams | null = null;
let captureId = 0;
let latest: Frame | null = null;
let lastError = "";
let waiters: { after: number; resolve: (f: Frame | null) => void; timer: ReturnType<typeof setTimeout>; }[] = [];

function flushWaiters(force = false) {
    const still: typeof waiters = [];
    for (const w of waiters) {
        if (latest && latest.seq > w.after) { clearTimeout(w.timer); w.resolve(latest); }
        else if (force) { clearTimeout(w.timer); w.resolve(null); }
        else still.push(w);
    }
    waiters = still;
}

export async function listOutputs(_: IpcMainInvokeEvent): Promise<OutputInfo[]> {
    if (!IS_WIN) return [];
    return JSON.parse(await runPs("[HdrCapture]::ListOutputs()") || "[]");
}

// ---------- what did the user pick in Vesktop's picker? ----------
// Vesktop's picker answers its main process on this channel; we only listen alongside it.
const VESKTOP_IPC_COMMAND = "VCD_IPC_COMMAND";
let lastPick: { id: string; at: number; } | null = null;

if (IS_WIN) {
    ipcMain.on(VESKTOP_IPC_COMMAND, (_e, msg) => {
        try {
            const id = msg?.ok ? msg?.data?.id : undefined;
            if (typeof id === "string" && /^(window|screen):/.test(id)) lastPick = { id, at: Date.now() };
        } catch { }
    });
}

/** The source picked for the share that just started (consumed once). */
export async function takePickedTarget(_: IpcMainInvokeEvent): Promise<CaptureTarget | null> {
    const pick = lastPick;
    lastPick = null;
    if (!pick || Date.now() - pick.at > 60_000) return null;

    const [kind, rawId] = pick.id.split(":");
    if (kind === "window") return /^\d+$/.test(rawId) ? { kind: "window", hwnd: rawId } : null;

    // screen:<id>:0 -> Electron display -> top-left in physical pixels (= DXGI desktop coordinates)
    try {
        const sources = await desktopCapturer.getSources({ types: ["screen"], thumbnailSize: { width: 0, height: 0 } });
        const src = sources.find(s => s.id === pick.id);
        const display = src && screen.getAllDisplays().find(d => String(d.id) === src.display_id);
        if (!display) return null;
        const r = screen.dipToScreenRect(null, display.bounds);
        return { kind: "screen", x: r.x, y: r.y };
    } catch {
        return null;
    }
}

export async function startCapture(_: IpcMainInvokeEvent, opts: CaptureOptions) {
    if (!IS_WIN) throw new Error("HDR capture is Windows only");
    stopCapture(_);

    const target = opts.target;
    let body: string;
    let out: OutputInfo | undefined;
    const common = `${num(opts.maxWidth)}, ${num(opts.maxHeight)}, ${num(opts.fps)}, ${num(opts.knee)}, ${num(opts.peakNits)}, ${num(opts.sdrWhiteNits)}`;
    if (target?.kind === "window") {
        if (!/^\d{1,20}$/.test(target.hwnd)) throw new Error("bad window id");
        body = `[HdrCapture]::RunWindow([long]${target.hwnd}, ${common})`;
    } else {
        out = pickOutput(await listOutputs(_), opts);
        if (!out) throw new Error("no monitors found");
        body = `[HdrCapture]::Run(${out.adapter}, ${out.output}, ${common})`;
    }

    const id = ++captureId;
    latest = null;
    lastError = "";
    const child = spawn("powershell.exe", psArgs(body), { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    proc = child;

    const parser = new FrameParser(f => {
        if (id !== captureId) return;
        latest = f;
        flushWaiters();
    }, "HDRF", (w, h) => w * h * 3 / 2);   // NV12
    child.stdout.on("data", (chunk: Buffer) => {
        try { parser.push(chunk); } catch (e) { lastError = String(e); child.kill(); }
    });

    return await new Promise<{ id: number; output?: OutputInfo; started: any; }>((resolve, reject) => {
        let stderrText = "";
        const timer = setTimeout(() => fail("timed out waiting for the first HDR frame"), 20000);
        function fail(msg: string) {
            clearTimeout(timer);
            lastError = msg;
            if (proc === child) stopCapture(_);
            reject(new Error(msg));
        }
        child.stderr.on("data", (d: Buffer) => {
            stderrText += d.toString();
            let nl: number;
            while ((nl = stderrText.indexOf("\n")) !== -1) {
                const line = stderrText.slice(0, nl).trim();
                stderrText = stderrText.slice(nl + 1);
                if (!line.startsWith("{")) { if (line) lastError = line; continue; }
                try {
                    const msg = JSON.parse(line);
                    if (msg.kind === "started") { clearTimeout(timer); resolve({ id, output: out, started: msg.detail }); }
                    else if (msg.kind === "ended") lastError = String(msg.detail);
                } catch { }
            }
        });
        child.on("exit", code => {
            if (id === captureId) { proc = null; flushWaiters(true); }
            fail(`HDR capture exited (${code})${lastError || stderrText ? ": " + (lastError || stderrText).trim().slice(0, 300) : ""}`);
        });
    });
}

/** Resolves with the next frame newer than `after`, or null on timeout / capture end. */
export function getFrame(_: IpcMainInvokeEvent, id: number, after: number, timeoutMs = 1000): Promise<Frame | null> {
    if (id !== captureId || (!proc && !latest)) return Promise.resolve(null);
    if (latest && latest.seq > after) return Promise.resolve(latest);
    if (!proc) return Promise.resolve(null);
    return new Promise(resolve => {
        const w = { after, resolve, timer: setTimeout(() => { waiters = waiters.filter(x => x !== w); resolve(null); }, timeoutMs) };
        waiters.push(w);
    });
}

export function captureStatus(_: IpcMainInvokeEvent, id: number) {
    return { running: id === captureId && proc !== null, lastError };
}

export function stopCapture(_: IpcMainInvokeEvent, id?: number) {
    if (id !== undefined && id !== captureId) return;
    const p = proc;
    proc = null;
    captureId++;
    latest = null;
    flushWaiters(true);
    if (p) {
        try { p.stdin.end(); } catch { }   // helper exits when stdin closes...
        setTimeout(() => { try { p.kill(); } catch { } }, 1500);   // ...or gets killed
    }
}

// ======================= per-app audio (window shares) =======================

let audioProc: ChildProcessWithoutNullStreams | null = null;
let audioId = 0;
let audioQueue: Buffer[] = [];
let audioQueued = 0;
let audioError = "";
/** Drop the oldest audio if the renderer falls this far behind (bytes: 0.5 s of 48 kHz stereo float). */
const AUDIO_MAX_QUEUE = 48000 * 2 * 4 / 2;

/** Starts capturing only the audio of the app that owns the window. Resolves once audio capture is running. */
export function startAudio(_: IpcMainInvokeEvent, hwnd: string) {
    if (!IS_WIN) return Promise.reject(new Error("Windows only"));
    if (!/^\d{1,20}$/.test(hwnd)) return Promise.reject(new Error("bad window id"));
    stopAudio(_);

    const id = ++audioId;
    audioQueue = []; audioQueued = 0; audioError = "";
    const child = spawn("powershell.exe", psArgs(`[HdrAudio]::Run([long]${hwnd})`), { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    audioProc = child;

    const parser = new FrameParser(f => {
        if (id !== audioId) return;
        audioQueue.push(Buffer.from(f.data));   // parser reuses its buffers, so copy
        audioQueued += f.data.length;
        while (audioQueued > AUDIO_MAX_QUEUE && audioQueue.length > 1) audioQueued -= audioQueue.shift()!.length;
    }, "HDRA", frames => frames * 2 * 4);
    child.stdout.on("data", (chunk: Buffer) => {
        try { parser.push(chunk); } catch (e) { audioError = String(e); child.kill(); }
    });

    return new Promise<{ id: number; pid: number; }>((resolve, reject) => {
        let stderrText = "";
        const timer = setTimeout(() => fail("timed out starting app audio capture"), 15000);
        function fail(msg: string) {
            clearTimeout(timer);
            audioError = msg;
            if (audioProc === child) stopAudio(_);
            reject(new Error(msg));
        }
        child.stderr.on("data", (d: Buffer) => {
            stderrText += d.toString();
            let nl: number;
            while ((nl = stderrText.indexOf("\n")) !== -1) {
                const line = stderrText.slice(0, nl).trim();
                stderrText = stderrText.slice(nl + 1);
                if (!line.startsWith("{")) { if (line) audioError = line; continue; }
                try {
                    const msg = JSON.parse(line);
                    if (msg.kind === "started") { clearTimeout(timer); resolve({ id, pid: msg.detail.pid }); }
                } catch { }
            }
        });
        child.on("exit", code => {
            if (id === audioId) audioProc = null;
            fail(`app audio capture exited (${code})${audioError || stderrText ? ": " + (audioError || stderrText).trim().slice(0, 300) : ""}`);
        });
    });
}

/** Everything captured since the last call (interleaved stereo float32 at 48 kHz). */
export function takeAudio(_: IpcMainInvokeEvent, id: number) {
    if (id !== audioId) return { running: false, data: null, error: audioError };
    const data = audioQueue.length ? Buffer.concat(audioQueue) : null;
    audioQueue = []; audioQueued = 0;
    return { running: audioProc !== null, data, error: audioError };
}

export function stopAudio(_: IpcMainInvokeEvent, id?: number) {
    if (id !== undefined && id !== audioId) return;
    const p = audioProc;
    audioProc = null;
    audioId++;
    audioQueue = []; audioQueued = 0;
    if (p) {
        try { p.stdin.end(); } catch { }
        setTimeout(() => { try { p.kill(); } catch { } }, 1500);
    }
}

// ======================= HDR video switching =======================

const originals = new Map<string, { display: DisplayHdrInfo; on: boolean; }>();
let queue: Promise<unknown> = Promise.resolve();
const key = (d: DisplayHdrInfo) => `${d.adapterHigh}:${d.adapterLow}:${d.targetId}`;

const setLine = (d: DisplayHdrInfo, on: boolean) =>
    `[HdrDisplays]::Set([uint32]${d.adapterLow}, [int]${d.adapterHigh}, [uint32]${d.targetId}, $${on})`;

async function query(point?: { x: number; y: number; }) {
    const body = point
        ? `[HdrDisplays]::Snapshot($true, ${Math.round(point.x)}, ${Math.round(point.y)})`
        : "[HdrDisplays]::Snapshot($false, 0, 0)";
    return JSON.parse(await runPs(body)) as { device: string; displays: DisplayHdrInfo[]; };
}

function windowCenter(event?: IpcMainInvokeEvent) {
    const win = (event && BrowserWindow.fromWebContents(event.sender)) || BrowserWindow.getAllWindows()[0];
    if (!win) return undefined;
    const b = win.getBounds();
    const p = { x: Math.round(b.x + b.width / 2), y: Math.round(b.y + b.height / 2) };
    return IS_WIN ? screen.dipToScreenPoint(p) : p;
}

async function apply(mode: HdrMode, event?: IpcMainInvokeEvent) {
    if (!IS_WIN) return { mode, changed: [] as string[], errors: [] as string[] };
    if (mode === "none" && !originals.size) return { mode, changed: [], errors: [] };

    const { device, displays } = await query(mode === "video" ? windowCenter(event) : undefined);
    const changes: { d: DisplayHdrInfo; on: boolean; }[] = [];
    for (const d of displays) {
        const original = originals.get(key(d))?.on ?? d.on;
        const want = mode === "video" && d.supported && d.name === device ? true : original;
        if (want !== d.on) changes.push({ d, on: want });
    }

    const changed: string[] = [];
    const errors: string[] = [];
    const nowOn = new Map(displays.map(d => [key(d), d.on]));
    if (changes.length) {
        for (const { d } of changes)
            if (!originals.has(key(d))) originals.set(key(d), { display: d, on: d.on });
        const codes = (await runPs(changes.map(c => setLine(c.d, c.on)).join("\n"))).split(/\r?\n/);
        changes.forEach((c, i) => {
            if (codes[i]?.trim() === "0") { changed.push(`${c.d.name} HDR ${c.on ? "on" : "off"}`); nowOn.set(key(c.d), c.on); }
            else errors.push(`${c.d.name}: error ${codes[i]}`);
        });
    }
    for (const [k, o] of originals)
        if (!nowOn.has(k) || nowOn.get(k) === o.on) originals.delete(k);

    return { mode, changed, errors };
}

/** Serialised so overlapping requests can't race each other. */
export function setMode(event: IpcMainInvokeEvent, mode: HdrMode) {
    const run = queue.then(() => apply(mode, event));
    queue = run.catch(() => { });
    return run;
}

// ---------- HDR video detection ----------

const probeCache = new Map<string, Promise<"pq" | "hlg" | "sdr" | "unknown">>();
const ALLOWED_HOSTS = /(^|\.)(discordapp\.com|discordapp\.net|discord\.com)$/i;

/** transfer_characteristics (ISO/IEC 23091-2): 16 = PQ (SMPTE 2084), 18 = HLG */
function scanForTransfer(buf: Buffer): "pq" | "hlg" | "sdr" | "unknown" {
    // MP4 / MOV: 'colr' box with 'nclx' or 'nclc' -> primaries u16, transfer u16, matrix u16
    for (let i = buf.indexOf("colr"); i !== -1; i = buf.indexOf("colr", i + 4)) {
        const kind = buf.toString("latin1", i + 4, i + 8);
        if ((kind === "nclx" || kind === "nclc") && i + 12 <= buf.length) {
            const tc = buf.readUInt16BE(i + 10);
            return tc === 16 ? "pq" : tc === 18 ? "hlg" : "sdr";
        }
    }
    // WebM / MKV: TransferCharacteristics element 0x55BA, 1-byte size (0x81), 1-byte value
    for (let i = buf.indexOf(Buffer.from([0x55, 0xba, 0x81])); i !== -1; i = buf.indexOf(Buffer.from([0x55, 0xba, 0x81]), i + 1)) {
        const tc = buf[i + 3];
        if (tc === 16) return "pq";
        if (tc === 18) return "hlg";
        return "sdr";
    }
    return "unknown";
}

async function fetchRange(url: string, range: string) {
    const res = await fetch(url, { headers: { Range: range } });
    if (!res.ok && res.status !== 206) throw new Error(`HTTP ${res.status}`);
    const reader = res.body?.getReader();
    if (!reader) return Buffer.alloc(0);
    const chunks: Buffer[] = [];
    let total = 0;
    while (total < 4 * 1024 * 1024) { // never pull more than 4 MB even if Range is ignored
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(Buffer.from(value));
        total += value.length;
    }
    reader.cancel().catch(() => { });
    return Buffer.concat(chunks);
}

export function probeHdr(_: IpcMainInvokeEvent, url: string) {
    let host: string;
    try { host = new URL(url).hostname; } catch { return Promise.resolve("unknown" as const); }
    if (!ALLOWED_HOSTS.test(host)) return Promise.resolve("unknown" as const);

    const cacheKey = url.split("?")[0];
    let p = probeCache.get(cacheKey);
    if (!p) {
        p = (async () => {
            const head = scanForTransfer(await fetchRange(url, "bytes=0-2097151"));
            if (head !== "unknown") return head;
            // Non-faststart MP4: the moov box (with 'colr') sits at the end of the file.
            return scanForTransfer(await fetchRange(url, "bytes=-2097152"));
        })().catch(() => "unknown" as const);
        probeCache.set(cacheKey, p);
    }
    return p;
}

// ======================= safety net =======================

if (IS_WIN) {
    app.on("will-quit", () => {
        stopCapture(undefined as any);
        stopAudio(undefined as any);
        if (!originals.size) return;
        const body = [...originals.values()].map(o => setLine(o.display, o.on)).join("\n");
        try { execFileSync("powershell.exe", psArgs(body), { windowsHide: true, timeout: 8000 }); } catch { }
        originals.clear();
    });
}
