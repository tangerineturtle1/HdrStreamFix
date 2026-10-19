/*
 * HdrStreamFix — C# helper compiled once by PowerShell (Add-Type) and cached as a DLL.
 * Talks to the Windows DisplayConfig API to read and toggle per-monitor HDR.
 *
 * Info types used (wingdi.h, DISPLAYCONFIG_DEVICE_INFO_TYPE):
 *   1  GET_SOURCE_NAME           -> "\\.\DISPLAY1" style names
 *   9  GET_ADVANCED_COLOR_INFO   -> pre-24H2 HDR state
 *   10 SET_ADVANCED_COLOR_STATE  -> pre-24H2 HDR toggle
 *   11 GET_SDR_WHITE_LEVEL       -> "SDR content brightness" slider, in 1/1000 of 80 nits
 *   15 GET_ADVANCED_COLOR_INFO_2 -> 24H2+ HDR state
 *   16 SET_HDR_STATE             -> 24H2+ HDR toggle
 */

export const HELPER_VERSION = 5;

export const CSHARP_USINGS = String.raw`
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
`;

export const DISPLAYS_CS = String.raw`
public static class HdrDisplays
{
    [StructLayout(LayoutKind.Sequential)] public struct LUID { public uint LowPart; public int HighPart; }

    [StructLayout(LayoutKind.Sequential)] public struct PATH_SOURCE_INFO { public LUID adapterId; public uint id; public uint modeInfoIdx; public uint statusFlags; }
    [StructLayout(LayoutKind.Sequential)] public struct RATIONAL { public uint Numerator; public uint Denominator; }
    [StructLayout(LayoutKind.Sequential)] public struct PATH_TARGET_INFO {
        public LUID adapterId; public uint id; public uint modeInfoIdx; public uint outputTechnology;
        public uint rotation; public uint scaling; public RATIONAL refreshRate; public uint scanLineOrdering;
        public int targetAvailable; public uint statusFlags;
    }
    [StructLayout(LayoutKind.Sequential)] public struct PATH_INFO { public PATH_SOURCE_INFO sourceInfo; public PATH_TARGET_INFO targetInfo; public uint flags; }
    [StructLayout(LayoutKind.Sequential, Size = 64)] public struct MODE_INFO { public uint infoType; public uint id; public LUID adapterId; }

    [StructLayout(LayoutKind.Sequential)] public struct HEADER { public int type; public uint size; public LUID adapterId; public uint id; }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    public struct SOURCE_NAME { public HEADER header; [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string viewGdiDeviceName; }
    [StructLayout(LayoutKind.Sequential)] public struct COLOR_INFO { public HEADER header; public uint value; public int colorEncoding; public uint bitsPerColorChannel; }
    [StructLayout(LayoutKind.Sequential)] public struct COLOR_INFO_2 { public HEADER header; public uint value; public int colorEncoding; public uint bitsPerColorChannel; public int activeColorMode; }
    [StructLayout(LayoutKind.Sequential)] public struct SDR_WHITE { public HEADER header; public uint SDRWhiteLevel; }
    [StructLayout(LayoutKind.Sequential)] public struct SET_STATE { public HEADER header; public uint value; }

    [DllImport("user32.dll")] static extern int GetDisplayConfigBufferSizes(uint flags, out uint numPaths, out uint numModes);
    [DllImport("user32.dll")] static extern int QueryDisplayConfig(uint flags, ref uint numPaths, [Out] PATH_INFO[] paths, ref uint numModes, [Out] MODE_INFO[] modes, IntPtr topology);
    [DllImport("user32.dll", EntryPoint = "DisplayConfigGetDeviceInfo")] static extern int GetName(ref SOURCE_NAME r);
    [DllImport("user32.dll", EntryPoint = "DisplayConfigGetDeviceInfo")] static extern int GetColor(ref COLOR_INFO r);
    [DllImport("user32.dll", EntryPoint = "DisplayConfigGetDeviceInfo")] static extern int GetColor2(ref COLOR_INFO_2 r);
    [DllImport("user32.dll", EntryPoint = "DisplayConfigGetDeviceInfo")] static extern int GetWhite(ref SDR_WHITE r);
    [DllImport("user32.dll", EntryPoint = "DisplayConfigSetDeviceInfo")] static extern int SetState(ref SET_STATE r);

    static HEADER Hdr(int type, Type t, LUID a, uint id) {
        HEADER h; h.type = type; h.size = (uint)Marshal.SizeOf(t); h.adapterId = a; h.id = id; return h;
    }

    static PATH_INFO[] Paths() {
        uint np, nm;
        int err = GetDisplayConfigBufferSizes(2 /* QDC_ONLY_ACTIVE_PATHS */, out np, out nm);
        if (err != 0) throw new Exception("GetDisplayConfigBufferSizes " + err);
        var paths = new PATH_INFO[np]; var modes = new MODE_INFO[nm];
        err = QueryDisplayConfig(2, ref np, paths, ref nm, modes, IntPtr.Zero);
        if (err != 0) throw new Exception("QueryDisplayConfig " + err);
        Array.Resize(ref paths, (int)np);
        return paths;
    }

    static string Esc(string s) { return (s ?? "").Replace("\\", "\\\\").Replace("\"", "\\\""); }

    // JSON array: [{ name, adapterLow, adapterHigh, targetId, supported, on, sdrWhiteNits }]
    public static string Query()
    {
        var sb = new StringBuilder("[");
        bool first = true;
        foreach (var p in Paths())
        {
            var t = p.targetInfo; var s = p.sourceInfo;

            var name = new SOURCE_NAME(); name.header = Hdr(1, typeof(SOURCE_NAME), s.adapterId, s.id);
            GetName(ref name);

            bool supported = false, on = false;
            var c2 = new COLOR_INFO_2(); c2.header = Hdr(15, typeof(COLOR_INFO_2), t.adapterId, t.id);
            if (GetColor2(ref c2) == 0) {
                supported = (c2.value & (1u << 4)) != 0;   // highDynamicRangeSupported
                on = c2.activeColorMode == 2;              // DISPLAYCONFIG_ADVANCED_COLOR_MODE_HDR
            } else {
                var c = new COLOR_INFO(); c.header = Hdr(9, typeof(COLOR_INFO), t.adapterId, t.id);
                if (GetColor(ref c) == 0) {
                    supported = (c.value & 1u) != 0;       // advancedColorSupported
                    on = (c.value & 2u) != 0;              // advancedColorEnabled
                }
            }

            double white = 80;
            var w = new SDR_WHITE(); w.header = Hdr(11, typeof(SDR_WHITE), t.adapterId, t.id);
            if (GetWhite(ref w) == 0 && w.SDRWhiteLevel > 0) white = w.SDRWhiteLevel * 80.0 / 1000.0;

            if (!first) sb.Append(","); first = false;
            sb.AppendFormat(System.Globalization.CultureInfo.InvariantCulture,
                "{{\"name\":\"{0}\",\"adapterLow\":{1},\"adapterHigh\":{2},\"targetId\":{3},\"supported\":{4},\"on\":{5},\"sdrWhiteNits\":{6}}}",
                Esc(name.viewGdiDeviceName), t.adapterId.LowPart, t.adapterId.HighPart, t.id,
                supported ? "true" : "false", on ? "true" : "false", white);
        }
        return sb.Append("]").ToString();
    }

    [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X; public int Y; }
    [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    public struct MONITORINFOEX { public int cbSize; public RECT rcMonitor; public RECT rcWork; public uint dwFlags;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string szDevice; }
    [DllImport("user32.dll")] static extern IntPtr MonitorFromPoint(POINT pt, uint flags);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern bool GetMonitorInfoW(IntPtr hMon, ref MONITORINFOEX info);

    // GDI device name ("\\.\DISPLAY1") of the monitor containing a physical-pixel point.
    public static string DeviceAt(int x, int y)
    {
        POINT p; p.X = x; p.Y = y;
        IntPtr mon = MonitorFromPoint(p, 2 /* MONITOR_DEFAULTTONEAREST */);
        var mi = new MONITORINFOEX(); mi.cbSize = Marshal.SizeOf(typeof(MONITORINFOEX));
        return GetMonitorInfoW(mon, ref mi) ? mi.szDevice : "";
    }

    // SDR content brightness (nits) for a GDI device name like "\\.\DISPLAY1"; 80 if unknown.
    public static double SdrWhiteFor(string gdiName)
    {
        foreach (var p in Paths())
        {
            var name = new SOURCE_NAME(); name.header = Hdr(1, typeof(SOURCE_NAME), p.sourceInfo.adapterId, p.sourceInfo.id);
            if (GetName(ref name) != 0 || !string.Equals(name.viewGdiDeviceName, gdiName, StringComparison.OrdinalIgnoreCase)) continue;
            var w = new SDR_WHITE(); w.header = Hdr(11, typeof(SDR_WHITE), p.targetInfo.adapterId, p.targetInfo.id);
            if (GetWhite(ref w) == 0 && w.SDRWhiteLevel > 0) return w.SDRWhiteLevel * 80.0 / 1000.0;
        }
        return 80;
    }

    // { device, displays } — device is the monitor at (x, y) when atPoint, else "".
    public static string Snapshot(bool atPoint, int x, int y)
    {
        string dev = atPoint ? DeviceAt(x, y) : "";
        return "{\"device\":\"" + Esc(dev) + "\",\"displays\":" + Query() + "}";
    }

    // Returns 0 on success, otherwise the Win32 error from the last attempt.
    public static int Set(uint adapterLow, int adapterHigh, uint targetId, bool enable)
    {
        LUID a; a.LowPart = adapterLow; a.HighPart = adapterHigh;
        var r = new SET_STATE(); r.value = enable ? 1u : 0u;
        r.header = Hdr(16, typeof(SET_STATE), a, targetId);      // 24H2+: SET_HDR_STATE
        int err = SetState(ref r);
        if (err == 0) return 0;
        r.header = Hdr(10, typeof(SET_STATE), a, targetId);      // older: SET_ADVANCED_COLOR_STATE
        return SetState(ref r);
    }
}
`;
