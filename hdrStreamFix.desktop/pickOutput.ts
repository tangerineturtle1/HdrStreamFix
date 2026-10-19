/* HdrStreamFix — choose which monitor to capture. */

export interface OutputInfo {
    adapter: number;
    output: number;
    name: string;
    x: number;
    y: number;
    width: number;
    height: number;
    hdr: boolean;
    maxNits: number;
    sdrWhiteNits: number;
    rotation: number;
}

export interface CaptureOptions {
    /** Size of the track Chromium gave us — used to pick the matching monitor in auto mode */
    trackWidth: number;
    trackHeight: number;
    maxWidth: number;
    maxHeight: number;
    fps: number;
    knee: number;
    peakNits: number;
    sdrWhiteNits: number;
    /** What the user picked in Vesktop's picker, if known */
    target?: CaptureTarget;
}

export type CaptureTarget =
    | { kind: "window"; hwnd: string; }
    /** Top-left of the picked screen in physical pixels (matches DXGI desktop coordinates) */
    | { kind: "screen"; x: number; y: number; };

export function pickOutput(outputs: OutputInfo[], opts: Pick<CaptureOptions, "trackWidth" | "trackHeight" | "target">) {
    if (!outputs.length) return undefined;
    // Exactly the screen picked in Vesktop's picker
    const t = opts.target;
    if (t?.kind === "screen") {
        const hit = outputs.find(o => o.x === t.x && o.y === t.y);
        if (hit) return hit;
    }

    const hdr = outputs.filter(o => o.hdr);
    const pool = hdr.length ? hdr : outputs;
    if (pool.length === 1) return pool[0];

    const exact = pool.filter(o => o.width === opts.trackWidth && o.height === opts.trackHeight);
    if (exact.length === 1) return exact[0];
    const aspect = opts.trackHeight ? opts.trackWidth / opts.trackHeight : 0;
    const sameAspect = pool.filter(o => Math.abs(o.width / o.height - aspect) < 0.01);
    const candidates = sameAspect.length ? sameAspect : pool;
    return candidates.find(o => o.x === 0 && o.y === 0) ?? candidates[0];
}
