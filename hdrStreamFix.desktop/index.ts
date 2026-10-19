/*
 * HdrStreamFix — proper HDR screen sharing for Vesktop on Windows, with HDR left ON.
 *
 * Screen and window shares: the plugin captures the real 16-bit HDR image itself (screens via DXGI
 * Desktop Duplication, windows via Windows.Graphics.Capture, both FP16), tone-maps it to SDR on the
 * GPU — highlights rolled off instead of clipped, SDR content kept at the brightness you see — and
 * swaps that into the Discord stream instead of Chromium's clipped 8-bit capture.
 * HDR videos in chat: HDR is switched on for Vesktop's monitor while one plays (if it was off).
 *
 * Author: Aa
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { definePluginSettings, Settings } from "@api/Settings";
import { localStorage } from "@utils/localStorage";
import { Logger } from "@utils/Logger";
import definePlugin, { OptionType, PluginNative } from "@utils/types";
import { showToast } from "@webpack/common";

import type { CaptureTarget, HdrMode } from "./native";

const Native = VencordNative.pluginHelpers.HdrStreamFix as PluginNative<typeof import("./native")>;
const logger = new Logger("HdrStreamFix");
const IS_WINDOWS = navigator.userAgent.includes("Windows");
/** Keep HDR on this long after an HDR video pauses, so scrubbing doesn't flicker the screen. */
const VIDEO_RELEASE_DELAY_S = 10;

declare const MediaStreamTrackGenerator: any;

const nits = (values: number[]) => values.map(n => ({ label: `${n} nits`, value: n }));
const KNEE_VALUES = [0.6, 0.75, 0.9];
const PEAK_VALUES = [0, 400, 600, 1000, 1500, 2000, 4000];
const WHITE_VALUES = [0, 80, 120, 160, 200, 240, 280, 320, 400, 480];

const settings = definePluginSettings({
    hdrCapture: {
        type: OptionType.BOOLEAN,
        displayName: "HDR Stream Fix",
        description: "When you share a screen or window, capture the real HDR image and convert it for viewers, so it isn't washed out or blown out.",
        default: true
    },
    sdrWhiteNits: {
        type: OptionType.SELECT,
        displayName: "Stream Brightness",
        description: "The brightness viewers see as white. If viewers say the stream is too bright, pick a higher number; too dark, a lower one.",
        options: [{ label: "Auto: match Windows' SDR content brightness", value: 0, default: true }, ...nits(WHITE_VALUES.slice(1))]
    },
    knee: {
        type: OptionType.SELECT,
        displayName: "Highlights",
        description: "How bright areas like the sun, lights and explosions are squeezed into the stream.",
        options: [
            { label: "More detail (whites slightly dimmer)", value: 0.6 },
            { label: "Balanced", value: 0.75, default: true },
            { label: "Punchier (less highlight detail)", value: 0.9 }
        ]
    },
    peakNits: {
        type: OptionType.SELECT,
        displayName: "Brightest Highlight",
        description: "Highlights up to this brightness keep their detail; anything brighter shows as white.",
        options: [{ label: "Auto: your monitor's peak brightness", value: 0, default: true }, ...nits(PEAK_VALUES.slice(1))]
    },
    appAudioOnly: {
        type: OptionType.BOOLEAN,
        displayName: "Window Audio Only",
        description: "When you share a window with audio, send only that app's sound. Voice chat, music and other apps are left out, so nobody hears themselves.",
        default: true
    },
    autoHdrForVideos: {
        type: OptionType.BOOLEAN,
        displayName: "HDR for Videos",
        description: "If Windows HDR is off, turn it on while an HDR video plays in chat. Needs Hardware Acceleration on in Vesktop's settings.",
        default: true
    },
    debug: {
        type: OptionType.BOOLEAN,
        displayName: "Debug Logging",
        description: "Log what the plugin does to the console (Ctrl+Shift+I).",
        default: false
    }
});

/** Settings from older versions of the plugin that no longer exist. */
const REMOVED_SETTINGS = ["monitor", "captureHeight", "captureFps", "windowCorrection", "paperWhiteNits", "videoReleaseDelay"];

const nearest = (values: number[], v: number) => values.reduce((a, b) => Math.abs(b - v) < Math.abs(a - v) ? b : a);

/** Older versions used sliders: snap stored values onto the dropdown options and drop removed settings. */
function migrateSettings() {
    const s = settings.store;
    if (!KNEE_VALUES.includes(s.knee)) s.knee = nearest(KNEE_VALUES, s.knee);
    if (!PEAK_VALUES.includes(s.peakNits)) s.peakNits = nearest(PEAK_VALUES, s.peakNits);
    if (!WHITE_VALUES.includes(s.sdrWhiteNits)) s.sdrWhiteNits = nearest(WHITE_VALUES, s.sdrWhiteNits);
    const raw = Settings.plugins.HdrStreamFix as Record<string, unknown>;
    for (const k of REMOVED_SETTINGS) if (k in raw) delete raw[k];
}

/** Resolution and frame rate chosen in Vesktop's share dialog (falls back to 1080p30). */
function streamQuality() {
    try {
        const q = JSON.parse(localStorage.getItem("VesktopState") ?? "{}").screenshareQuality;
        const height = Number(q?.resolution) || 1080;
        const fps = Number(q?.frameRate) || 30;
        return { height, fps };
    } catch {
        return { height: 1080, fps: 30 };
    }
}

function debug(...args: any[]) {
    if (settings.store.debug) logger.info(...args);
}

function toast(text: string, variant: "critical" | "success" | "primary" = "critical") {
    showToast({ text: `HdrStreamFix: ${text}`, variant } as any);
}

// ======================= screen share =======================

let originalGetDisplayMedia: MediaDevices["getDisplayMedia"] | undefined;
const activeCaptures = new Set<() => void>();

function isScreenTrack(track: MediaStreamTrack) {
    const s = track.getSettings() as MediaTrackSettings & { displaySurface?: string; };
    if (s.displaySurface) return s.displaySurface === "monitor";
    return /^screen/i.test(track.label);
}

/** The helper sends NV12 in BT.709 limited range with sRGB gamma (what the GPU shader writes). */
const NV12_COLOR_SPACE = { primaries: "bt709", transfer: "iec61966-2-1", matrix: "bt709", fullRange: false } as const;

/** Replaces Chromium's (clipped) capture with the native HDR-tone-mapped capture of the same screen/window. */
async function swapInHdrCapture(stream: MediaStream, video: MediaStreamTrack, target: CaptureTarget | null) {
    const s = video.getSettings();
    const { height: h, fps } = streamQuality();

    const started = await Native.startCapture({
        trackWidth: s.width ?? 0,
        trackHeight: s.height ?? 0,
        maxWidth: Math.round(h * 32 / 9), // allow ultrawide at the chosen height
        maxHeight: h,
        fps,
        knee: settings.store.knee,
        peakNits: settings.store.peakNits,
        sdrWhiteNits: settings.store.sdrWhiteNits,
        target: target ?? undefined
    });
    debug("HDR capture started", started);

    const generator: MediaStreamTrack = new MediaStreamTrackGenerator({ kind: "video" });
    const writer = (generator as any).writable.getWriter();
    try { generator.contentHint = video.contentHint || "motion"; } catch { }

    let running = true;
    const end = () => {
        if (!running) return;
        running = false;
        activeCaptures.delete(end);
        Native.stopCapture(started.id);
        writer.close().catch(() => { });
        debug("HDR capture stopped");
    };
    activeCaptures.add(end);

    const origStop = generator.stop.bind(generator);
    generator.stop = () => { end(); origStop(); };

    // Discord tweaks/reads the track like a camera; a generator track would reject or report nothing.
    let lastW = 0, lastH = 0;
    const baseSettings = video.getSettings();
    generator.applyConstraints = async () => { };
    generator.getConstraints = () => video.getConstraints();
    generator.getSettings = () => ({ ...baseSettings, width: lastW || baseSettings.width, height: lastH || baseSettings.height, frameRate: fps });

    (async () => {
        let seq = 0;
        let misses = 0;
        while (running) {
            const f = await Native.getFrame(started.id, seq, 1000);
            if (!running) break;
            if (!f) {
                // Static screen = no new frames, which is fine. A dead helper is not.
                if (++misses % 3 === 0) {
                    const st = await Native.captureStatus(started.id);
                    if (!st.running) {
                        logger.error("HDR capture died", st.lastError);
                        toast(`HDR capture stopped (${st.lastError || "unknown error"})`);
                        end();
                        origStop();
                        break;
                    }
                }
                continue;
            }
            misses = 0;
            seq = f.seq;
            lastW = f.width; lastH = f.height;
            try {
                const frame = new VideoFrame(f.data, {
                    format: "NV12",
                    codedWidth: f.width,
                    codedHeight: f.height,
                    timestamp: Math.round(performance.now() * 1000),
                    colorSpace: NV12_COLOR_SPACE
                });
                await writer.write(frame);
            } catch (e) {
                logger.error("Failed to push frame", e);
                end();
            }
        }
    })();

    // Swap tracks: Chromium's capture is stopped so we don't pay for two captures.
    stream.removeTrack(video);
    stream.addTrack(generator);
    video.stop();
    return started;
}

async function patchedGetDisplayMedia(this: MediaDevices, opts?: DisplayMediaStreamOptions) {
    const stream = await originalGetDisplayMedia!.call(this, opts);
    const [video] = stream.getVideoTracks();
    if (!video) return stream;

    // Vesktop tells its main process which source you picked; the plugin's native side records it.
    const target = await Native.takePickedTarget().catch(() => null);
    const isWindow = target ? target.kind === "window" : !isScreenTrack(video);
    debug("share picked", target, isWindow ? "window" : "screen");

    if (settings.store.hdrCapture && (!isWindow || target?.kind === "window")) {
        try {
            const started = await swapInHdrCapture(stream, video, target);
            if (settings.store.debug) toast(`HDR capture on ${started.started?.name ?? started.output?.name ?? "source"}`, "success");
        } catch (e) {
            logger.error("HDR capture failed, using normal capture", e);
            toast(`HDR capture unavailable, using normal capture (${errorText(e)})`);
        }
    }

    // Window shares: replace Vesktop's whole-system audio with just that app's audio.
    const [audio] = stream.getAudioTracks();
    if (audio && target?.kind === "window" && settings.store.appAudioOnly) {
        try {
            const started = await swapInAppAudio(stream, audio, target.hwnd);
            debug("app audio started", started);
        } catch (e) {
            logger.error("App audio capture failed, keeping system audio", e);
            toast(`Couldn't capture just the app's audio, sharing system audio instead (${errorText(e)})`);
        }
    }
    return stream;
}

const errorText = (e: unknown) => String((e as Error)?.message ?? e).slice(0, 120);

declare const AudioData: any;
const AUDIO_RATE = 48000;

/** Replaces the system-audio track with audio from only the app that owns the shared window. */
async function swapInAppAudio(stream: MediaStream, original: MediaStreamTrack, hwnd: string) {
    const started = await Native.startAudio(hwnd);

    const generator: MediaStreamTrack = new MediaStreamTrackGenerator({ kind: "audio" });
    const writer = (generator as any).writable.getWriter();
    let running = true;
    let framesSent = 0;
    let busy = false;

    const end = () => {
        if (!running) return;
        running = false;
        clearInterval(timer);
        activeCaptures.delete(end);
        Native.stopAudio(started.id);
        writer.close().catch(() => { });
        debug("app audio stopped");
    };
    activeCaptures.add(end);

    const origStop = generator.stop.bind(generator);
    generator.stop = () => { end(); origStop(); };
    const baseSettings = original.getSettings();
    generator.applyConstraints = async () => { };
    generator.getConstraints = () => original.getConstraints();
    generator.getSettings = () => ({ ...baseSettings, sampleRate: AUDIO_RATE, channelCount: 2 });

    const timer = setInterval(async () => {
        if (busy || !running) return;
        busy = true;
        try {
            const r = await Native.takeAudio(started.id);
            if (!running) return;
            if (r.data) {
                const samples = new Float32Array(new Uint8Array(r.data).buffer);   // copy = 4-byte aligned
                const frames = samples.length / 2;
                await writer.write(new AudioData({
                    format: "f32",
                    sampleRate: AUDIO_RATE,
                    numberOfChannels: 2,
                    numberOfFrames: frames,
                    timestamp: Math.round(framesSent * 1e6 / AUDIO_RATE),
                    data: samples
                }));
                framesSent += frames;
            } else if (!r.running) {
                logger.error("App audio capture stopped", r.error);
                toast(`App audio stopped (${r.error || "the app closed"})`);
                end();
                origStop();
            }
        } catch (e) {
            logger.error("Failed to push audio", e);
        } finally {
            busy = false;
        }
    }, 20);

    stream.removeTrack(original);
    stream.addTrack(generator);
    original.stop();
    return started;
}

// ======================= HDR videos =======================

const hdrVideos = new Set<HTMLVideoElement>();
let requestedMode: HdrMode = "none";
let syncTimer: ReturnType<typeof setTimeout> | undefined;
let watchTimer: ReturnType<typeof setInterval> | undefined;

async function pushMode(mode: HdrMode) {
    if (mode === requestedMode) return;
    requestedMode = mode;
    try {
        const res = await Native.setMode(mode);
        debug(`HDR mode -> ${mode}`, res);
        if (res.errors.length) {
            logger.error("HDR switch failed", res.errors);
            toast(`couldn't switch HDR (${res.errors[0]})`);
        }
    } catch (e) {
        logger.error("HDR helper failed", e);
        toast("HDR helper failed — see console");
    }
}

function syncVideoMode(delaySec = 0) {
    clearTimeout(syncTimer);
    const want = (): HdrMode => hdrVideos.size && settings.store.autoHdrForVideos ? "video" : "none";
    if (delaySec <= 0) return pushMode(want());
    syncTimer = setTimeout(() => pushMode(want()), delaySec * 1000);
}

function dropVideo(v: HTMLVideoElement) {
    if (!hdrVideos.delete(v)) return;
    debug("HDR video stopped", v.currentSrc);
    syncVideoMode(VIDEO_RELEASE_DELAY_S);
    if (!hdrVideos.size) { clearInterval(watchTimer); watchTimer = undefined; }
}

const onPause = (e: Event) => dropVideo(e.target as HTMLVideoElement);

async function onPlay(e: Event) {
    const v = e.target;
    if (!(v instanceof HTMLVideoElement) || !settings.store.autoHdrForVideos) return;
    const url = v.currentSrc || v.src;
    if (!url || url.startsWith("blob:")) return;

    const transfer = await Native.probeHdr(url);
    debug("video", transfer, url);
    if (transfer !== "pq" && transfer !== "hlg") return;
    if (v.paused || v.ended || !v.isConnected) return;

    if (!hdrVideos.has(v)) {
        hdrVideos.add(v);
        for (const ev of ["pause", "ended", "emptied"]) v.addEventListener(ev, onPause, { once: true });
    }
    // Videos removed from the page (closed the media viewer) don't fire pause.
    watchTimer ??= setInterval(() => hdrVideos.forEach(x => { if (!x.isConnected) dropVideo(x); }), 2000);
    syncVideoMode();
}

// ======================= plugin =======================

export default definePlugin({
    name: "HdrStreamFix",
    description: "Makes screen shares look right when Windows HDR is on. Normally viewers see a washed-out or too-bright picture; this captures your screen or window in HDR and converts it so it looks like it does on your monitor. Window shares also send only that app's audio, so nobody hears themselves. Can also turn HDR on for HDR videos in chat.",
    authors: [{ name: "Aa", id: 0n }],
    settings,

    start() {
        migrateSettings();
        if (!IS_WINDOWS) {
            logger.warn("Windows only — doing nothing");
            return;
        }
        // Restore anything a previous session (Ctrl+R mid-video) left switched.
        requestedMode = "video";
        pushMode("none");

        originalGetDisplayMedia = navigator.mediaDevices.getDisplayMedia;
        navigator.mediaDevices.getDisplayMedia = patchedGetDisplayMedia;
        document.addEventListener("play", onPlay, true);
    },

    stop() {
        if (originalGetDisplayMedia) navigator.mediaDevices.getDisplayMedia = originalGetDisplayMedia;
        originalGetDisplayMedia = undefined;
        activeCaptures.forEach(end => end());
        document.removeEventListener("play", onPlay, true);
        clearInterval(watchTimer); watchTimer = undefined;
        clearTimeout(syncTimer);
        hdrVideos.clear();
        pushMode("none");
    }
});
