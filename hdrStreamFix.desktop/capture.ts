/*
 * HdrStreamFix — native HDR capture helper (C#, compiled once by PowerShell's Add-Type).
 *
 * Two capture sources, one GPU pipeline:
 *   Run(...)       — a whole monitor via DXGI Desktop Duplication (DuplicateOutput1, R16G16B16A16_FLOAT)
 *   RunWindow(...) — a single window via Windows.Graphics.Capture with an FP16 frame pool
 * Both deliver the real scRGB HDR image (nothing clipped). ToneMapper then tone-maps it to SDR on the
 * GPU, downscales to the stream size, and the frames go to stdout:
 *
 *   [ "HDRF" | width u32 LE | height u32 LE | seq u32 LE ] + width*height*3/2 bytes NV12
 *   (Y plane, then interleaved UV at half resolution; BT.709 limited range, sRGB transfer).
 *
 * NV12 is what Discord's encoder consumes, and it is 2.7x smaller than BGRA, so converting on the
 * GPU cuts the data moved per frame (pipe, Vesktop IPC, VideoFrame copy) and skips the encoder's own
 * RGB -> YUV pass.
 *
 * COM / WinRT are called through raw vtable slots (verified against Microsoft's windows-rs metadata)
 * so no extra assemblies are needed — this compiles with PowerShell 5.1's C# 5 compiler.
 * Status and errors go to stderr as single JSON lines.
 */

export const CAPTURE_CS = String.raw`
public static class HdrCapture
{
    // =====================================================================================
    // COM plumbing
    // =====================================================================================
    static T Fn<T>(IntPtr obj, int slot) where T : class
    {
        IntPtr vtbl = Marshal.ReadIntPtr(obj);
        return (T)(object)Marshal.GetDelegateForFunctionPointer(Marshal.ReadIntPtr(vtbl, slot * IntPtr.Size), typeof(T));
    }
    static void Check(int hr, string what) { if (hr < 0) throw new Exception(what + " failed: 0x" + hr.ToString("X8")); }
    static void Rel(ref IntPtr p) { if (p != IntPtr.Zero) { Fn<ReleaseFn>(p, 2)(p); p = IntPtr.Zero; } }
    static IntPtr QI(IntPtr obj, Guid iid) { IntPtr o; Check(Fn<QIFn>(obj, 0)(obj, ref iid, out o), "QueryInterface"); return o; }
    static IntPtr TryQI(IntPtr obj, Guid iid) { IntPtr o; return Fn<QIFn>(obj, 0)(obj, ref iid, out o) >= 0 ? o : IntPtr.Zero; }

    [UnmanagedFunctionPointer(CallingConvention.StdCall)] delegate uint ReleaseFn(IntPtr self);
    [UnmanagedFunctionPointer(CallingConvention.StdCall)] delegate int QIFn(IntPtr self, ref Guid iid, out IntPtr obj);
    [UnmanagedFunctionPointer(CallingConvention.StdCall)] delegate int EnumFn(IntPtr self, uint index, out IntPtr obj);
    [UnmanagedFunctionPointer(CallingConvention.StdCall)] delegate int GetDescFn(IntPtr self, IntPtr desc);
    [UnmanagedFunctionPointer(CallingConvention.StdCall)] delegate int DuplicateOutput1Fn(IntPtr self, IntPtr device, uint flags, uint count, int[] formats, out IntPtr dup);
    [UnmanagedFunctionPointer(CallingConvention.StdCall)] delegate int AcquireFn(IntPtr self, uint timeoutMs, IntPtr frameInfo, out IntPtr resource);
    [UnmanagedFunctionPointer(CallingConvention.StdCall)] delegate int NoArgFn(IntPtr self);
    [UnmanagedFunctionPointer(CallingConvention.StdCall)] delegate int PointerShapeFn(IntPtr self, uint bufSize, IntPtr buf, out uint required, out POINTER_SHAPE_INFO info);
    [UnmanagedFunctionPointer(CallingConvention.StdCall)] delegate int CreateTex2DFn(IntPtr self, ref TEX2D_DESC desc, IntPtr init, out IntPtr tex);
    [UnmanagedFunctionPointer(CallingConvention.StdCall)] delegate int CreateViewFn(IntPtr self, IntPtr resource, IntPtr desc, out IntPtr view);
    [UnmanagedFunctionPointer(CallingConvention.StdCall)] delegate int CreateShaderFn(IntPtr self, IntPtr code, IntPtr len, IntPtr linkage, out IntPtr shader);
    [UnmanagedFunctionPointer(CallingConvention.StdCall)] delegate int CreateSamplerFn(IntPtr self, ref SAMPLER_DESC desc, out IntPtr sampler);
    [UnmanagedFunctionPointer(CallingConvention.StdCall)] delegate int CreateBufferFn(IntPtr self, ref BUFFER_DESC desc, ref SUBRESOURCE_DATA init, out IntPtr buffer);
    [UnmanagedFunctionPointer(CallingConvention.StdCall)] delegate void TexGetDescFn(IntPtr self, out TEX2D_DESC desc);
    [UnmanagedFunctionPointer(CallingConvention.StdCall)] delegate void SetArrFn(IntPtr self, uint start, uint num, IntPtr[] items);
    [UnmanagedFunctionPointer(CallingConvention.StdCall)] delegate void SetShaderFn(IntPtr self, IntPtr shader, IntPtr classInstances, uint num);
    [UnmanagedFunctionPointer(CallingConvention.StdCall)] delegate void DrawFn(IntPtr self, uint count, uint start);
    [UnmanagedFunctionPointer(CallingConvention.StdCall)] delegate int MapFn(IntPtr self, IntPtr res, uint sub, uint type, uint flags, out MAPPED mapped);
    [UnmanagedFunctionPointer(CallingConvention.StdCall)] delegate void UnmapFn(IntPtr self, IntPtr res, uint sub);
    [UnmanagedFunctionPointer(CallingConvention.StdCall)] delegate void SetPtrFn(IntPtr self, IntPtr p);
    [UnmanagedFunctionPointer(CallingConvention.StdCall)] delegate void SetUIntFn(IntPtr self, uint v);
    [UnmanagedFunctionPointer(CallingConvention.StdCall)] delegate void OMSetRTFn(IntPtr self, uint num, IntPtr[] rtvs, IntPtr dsv);
    [UnmanagedFunctionPointer(CallingConvention.StdCall)] delegate void ViewportsFn(IntPtr self, uint num, ref VIEWPORT vp);
    [UnmanagedFunctionPointer(CallingConvention.StdCall)] delegate void CopyRegionFn(IntPtr self, IntPtr dst, uint dstSub, uint x, uint y, uint z, IntPtr src, uint srcSub, ref BOX box);
    [UnmanagedFunctionPointer(CallingConvention.StdCall)] delegate void CopyFn(IntPtr self, IntPtr dst, IntPtr src);
    [UnmanagedFunctionPointer(CallingConvention.StdCall)] delegate void UpdateSubFn(IntPtr self, IntPtr dst, uint dstSub, IntPtr box, IntPtr data, uint rowPitch, uint depthPitch);
    [UnmanagedFunctionPointer(CallingConvention.StdCall)] delegate IntPtr BlobFn(IntPtr self);
    // WinRT / interop
    [UnmanagedFunctionPointer(CallingConvention.StdCall)] delegate int CreateForWindowFn(IntPtr self, IntPtr hwnd, ref Guid iid, out IntPtr item);
    [UnmanagedFunctionPointer(CallingConvention.StdCall)] delegate int GetSizeFn(IntPtr self, out SIZE32 size);
    [UnmanagedFunctionPointer(CallingConvention.StdCall)] delegate int CreateFreeThreadedFn(IntPtr self, IntPtr device, int format, int buffers, SIZE32 size, out IntPtr pool);
    [UnmanagedFunctionPointer(CallingConvention.StdCall)] delegate int RecreateFn(IntPtr self, IntPtr device, int format, int buffers, SIZE32 size);
    [UnmanagedFunctionPointer(CallingConvention.StdCall)] delegate int OutPtrFn(IntPtr self, out IntPtr result);
    [UnmanagedFunctionPointer(CallingConvention.StdCall)] delegate int CreateSessionFn(IntPtr self, IntPtr item, out IntPtr session);
    [UnmanagedFunctionPointer(CallingConvention.StdCall)] delegate int SetBoolFn(IntPtr self, [MarshalAs(UnmanagedType.U1)] bool value);
    [UnmanagedFunctionPointer(CallingConvention.StdCall)] delegate int GetInterfaceFn(IntPtr self, ref Guid iid, out IntPtr obj);

    [StructLayout(LayoutKind.Sequential)] public struct TEX2D_DESC {
        public uint Width, Height, MipLevels, ArraySize, Format, SampleCount, SampleQuality, Usage, BindFlags, CPUAccessFlags, MiscFlags; }
    [StructLayout(LayoutKind.Sequential)] public struct SAMPLER_DESC {
        public uint Filter, AddressU, AddressV, AddressW; public float MipLODBias; public uint MaxAnisotropy, ComparisonFunc;
        public float B0, B1, B2, B3, MinLOD, MaxLOD; }
    [StructLayout(LayoutKind.Sequential)] public struct BUFFER_DESC { public uint ByteWidth, Usage, BindFlags, CPUAccessFlags, MiscFlags, StructureByteStride; }
    [StructLayout(LayoutKind.Sequential)] public struct SUBRESOURCE_DATA { public IntPtr pSysMem; public uint SysMemPitch, SysMemSlicePitch; }
    [StructLayout(LayoutKind.Sequential)] public struct MAPPED { public IntPtr pData; public uint RowPitch, DepthPitch; }
    [StructLayout(LayoutKind.Sequential)] public struct VIEWPORT { public float X, Y, W, H, MinDepth, MaxDepth; }
    [StructLayout(LayoutKind.Sequential)] public struct BOX { public uint Left, Top, Front, Right, Bottom, Back; }
    [StructLayout(LayoutKind.Sequential)] public struct SIZE32 { public int Width, Height; }
    [StructLayout(LayoutKind.Sequential)] public struct POINTER_SHAPE_INFO { public uint Type, Width, Height, Pitch; public int HotX, HotY; }
    [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    public struct MONITORINFOEX { public int cbSize; public RECT rcMonitor; public RECT rcWork; public uint dwFlags;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string szDevice; }

    [DllImport("dxgi.dll")] static extern int CreateDXGIFactory1(ref Guid iid, out IntPtr factory);
    [DllImport("d3d11.dll")] static extern int D3D11CreateDevice(IntPtr adapter, int driverType, IntPtr software, uint flags,
        IntPtr levels, uint numLevels, uint sdk, out IntPtr device, out int level, out IntPtr context);
    [DllImport("d3d11.dll")] static extern int CreateDirect3D11DeviceFromDXGIDevice(IntPtr dxgiDevice, out IntPtr inspectable);
    [DllImport("d3dcompiler_47.dll", CharSet = CharSet.Ansi)] static extern int D3DCompile(byte[] src, IntPtr size, string name,
        IntPtr defines, IntPtr include, string entry, string target, uint flags1, uint flags2, out IntPtr code, out IntPtr errors);
    [DllImport("combase.dll", CharSet = CharSet.Unicode)] static extern int WindowsCreateString(string src, uint length, out IntPtr hstring);
    [DllImport("combase.dll")] static extern int WindowsDeleteString(IntPtr hstring);
    [DllImport("combase.dll")] static extern int RoGetActivationFactory(IntPtr classId, ref Guid iid, out IntPtr factory);
    [DllImport("user32.dll")] static extern bool SetProcessDpiAwarenessContext(IntPtr ctx);
    [DllImport("user32.dll")] static extern IntPtr SetThreadDpiAwarenessContext(IntPtr ctx);
    [DllImport("user32.dll")] static extern bool IsWindow(IntPtr hwnd);
    [DllImport("user32.dll")] static extern IntPtr MonitorFromWindow(IntPtr hwnd, uint flags);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern bool GetMonitorInfoW(IntPtr hMon, ref MONITORINFOEX info);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowTextW(IntPtr hwnd, StringBuilder text, int max);

    static readonly Guid IID_Factory1 = new Guid("770aae78-f26f-4dba-a829-253c83d1b387");
    static readonly Guid IID_Output6 = new Guid("068346e8-aaec-4b84-add7-137f513f77a1");
    static readonly Guid IID_Tex2D = new Guid("6f15aaf2-d208-4e89-9ab4-489535d34f9c");
    static readonly Guid IID_DXGIDevice = new Guid("54ec77fa-1377-44e6-8c32-88fd5f44c84c");
    // Windows.Graphics.Capture (GUIDs and slot order checked against windows-rs metadata)
    static readonly Guid IID_ItemInterop = new Guid("3628e81b-3cac-4c60-b7f4-23ce0e0c3356");      // CreateForWindow = 3
    static readonly Guid IID_Item = new Guid("79c3f95b-31f7-4ec2-a464-632ef5d30760");             // Size = 7
    static readonly Guid IID_PoolStatics2 = new Guid("589b103f-6bbc-5df5-a991-02e28b3b66d5");     // CreateFreeThreaded = 6
    static readonly Guid IID_Pool = new Guid("24eb6d22-1975-422e-82e7-780dbd8ddf24");             // Recreate 6, TryGetNextFrame 7, CreateCaptureSession 10
    static readonly Guid IID_Frame = new Guid("fa50c623-38da-4b32-acf3-fa9734ad800e");            // Surface 6, ContentSize 8
    static readonly Guid IID_Session = new Guid("814e42a9-f70f-4ad7-939b-fddcc6eb880d");          // StartCapture 6
    static readonly Guid IID_Session2 = new Guid("2c39ae40-7d2e-5044-804e-8b6799d4cf9e");         // SetIsCursorCaptureEnabled 7
    static readonly Guid IID_Session3 = new Guid("f2cdd966-22ae-5ea1-9596-3a289344c3be");         // SetIsBorderRequired 7
    static readonly Guid IID_Closable = new Guid("30d5a829-7fa4-4026-83bb-d75bae4ea99e");         // Close 6
    static readonly Guid IID_D3DDevice = new Guid("a37624ab-8d5f-4650-9d3e-9eae3d9bc670");
    static readonly Guid IID_DxgiAccess = new Guid("a9b3d012-3df2-4ee3-b8d1-8695f457d3c1");       // GetInterface = 3

    const int WAIT_TIMEOUT = unchecked((int)0x887A0027);
    const int FMT_FP16 = 10, FMT_BGRA8 = 87, FMT_R8 = 61, FMT_R8G8 = 49;
    const System.Globalization.NumberStyles NS = System.Globalization.NumberStyles.Float;
    static readonly System.Globalization.CultureInfo INV = System.Globalization.CultureInfo.InvariantCulture;

    static void Close(ref IntPtr obj)
    {
        if (obj == IntPtr.Zero) return;
        IntPtr c = TryQI(obj, IID_Closable);
        if (c != IntPtr.Zero) { Fn<NoArgFn>(c, 6)(c); Rel(ref c); }
        Rel(ref obj);
    }

    static IntPtr Factory(string className, Guid iid)
    {
        IntPtr hs, f;
        Check(WindowsCreateString(className, (uint)className.Length, out hs), "WindowsCreateString");
        try { Check(RoGetActivationFactory(hs, ref iid, out f), "RoGetActivationFactory(" + className + ")"); }
        finally { WindowsDeleteString(hs); }
        return f;
    }

    // =====================================================================================
    // Output enumeration
    // =====================================================================================
    public class OutputInfo
    {
        public int Adapter, Output, X, Y, W, H, Rotation;
        public string Name;
        public bool Hdr;
        public double MaxNits, SdrWhite;
    }

    static string Esc(string s) { return (s ?? "").Replace("\\", "\\\\").Replace("\"", "\\\""); }

    static OutputInfo Describe(IntPtr output6, int a, int o)
    {
        IntPtr d = Marshal.AllocHGlobal(152);
        try
        {
            Check(Fn<GetDescFn>(output6, 27)(output6, d), "GetDesc1");
            var info = new OutputInfo();
            info.Adapter = a; info.Output = o;
            info.Name = Marshal.PtrToStringUni(d, 32).TrimEnd('\0');
            int l = Marshal.ReadInt32(d, 64), t = Marshal.ReadInt32(d, 68), r = Marshal.ReadInt32(d, 72), b = Marshal.ReadInt32(d, 76);
            info.X = l; info.Y = t; info.W = r - l; info.H = b - t;
            info.Rotation = Marshal.ReadInt32(d, 84);
            info.Hdr = Marshal.ReadInt32(d, 100) == 12;   // DXGI_COLOR_SPACE_RGB_FULL_G2084_NONE_P2020
            byte[] f = new byte[4];
            Marshal.Copy(IntPtr.Add(d, 140), f, 0, 4);
            info.MaxNits = BitConverter.ToSingle(f, 0);
            info.SdrWhite = HdrDisplays.SdrWhiteFor(info.Name);
            return info;
        }
        finally { Marshal.FreeHGlobal(d); }
    }

    // Walks adapters/outputs. visit returns true to keep adapter + output6 alive (caller then owns them).
    delegate bool Visitor(IntPtr adapter, IntPtr output6, OutputInfo info);
    static void Walk(Visitor visit)
    {
        Guid g = IID_Factory1; IntPtr factory;
        Check(CreateDXGIFactory1(ref g, out factory), "CreateDXGIFactory1");
        try
        {
            for (uint a = 0; ; a++)
            {
                IntPtr adapter;
                if (Fn<EnumFn>(factory, 12)(factory, a, out adapter) < 0) break;   // DXGI_ERROR_NOT_FOUND = no more adapters
                bool keep = false;
                for (uint o = 0; ; o++)
                {
                    IntPtr output;
                    if (Fn<EnumFn>(adapter, 7)(adapter, o, out output) < 0) break;
                    IntPtr out6 = TryQI(output, IID_Output6);
                    Rel(ref output);
                    if (out6 == IntPtr.Zero) continue;
                    if (visit(adapter, out6, Describe(out6, (int)a, (int)o))) { keep = true; break; }
                    Rel(ref out6);
                }
                if (keep) return;
                Rel(ref adapter);
            }
        }
        finally { Rel(ref factory); }
    }

    public static string ListOutputs()
    {
        var sb = new StringBuilder("[");
        Walk(delegate (IntPtr ad, IntPtr o6, OutputInfo i)
        {
            if (sb.Length > 1) sb.Append(",");
            sb.AppendFormat(INV,
                "{{\"adapter\":{0},\"output\":{1},\"name\":\"{2}\",\"x\":{3},\"y\":{4},\"width\":{5},\"height\":{6},\"hdr\":{7},\"maxNits\":{8},\"sdrWhiteNits\":{9},\"rotation\":{10}}}",
                i.Adapter, i.Output, Esc(i.Name), i.X, i.Y, i.W, i.H, i.Hdr ? "true" : "false", i.MaxNits, i.SdrWhite, i.Rotation);
            return false;
        });
        return sb.Append("]").ToString();
    }

    static OutputInfo FindOutput(string gdiName)
    {
        OutputInfo found = null;
        Walk(delegate (IntPtr ad, IntPtr o6, OutputInfo i)
        {
            if (found == null && string.Equals(i.Name, gdiName, StringComparison.OrdinalIgnoreCase)) found = i;
            return false;
        });
        return found;
    }

    // =====================================================================================
    // GPU tone mapping: scRGB FP16 texture in -> SDR NV12 bytes out (shared by both sources)
    // =====================================================================================
    const string HLSL = @"
cbuffer P : register(b0) { float scale; float peak; float knee; float pad; };
Texture2D tex : register(t0);
SamplerState smp : register(s0);
struct VO { float4 pos : SV_Position; float2 uv : TEXCOORD0; };
VO vs(uint id : SV_VertexID) {
    VO o; float2 p = float2((id << 1) & 2, id & 2);
    o.uv = p; o.pos = float4(p.x * 2 - 1, 1 - p.y * 2, 0, 1); return o;
}
float3 rolloff(float3 c) {
    float m = max(max(c.r, c.g), c.b);
    if (m <= knee || peak <= 1.0) return c;
    float span = 1.0 - knee;
    float u = (m - knee) / span;
    float U = max((peak - knee) / span, 1e-3);
    float mm = knee + span * (u * (1.0 + u / (U * U)) / (1.0 + u));
    return c * (mm / m);
}
float3 toSrgb(float3 l) {
    l = saturate(l);
    return l <= 0.0031308 ? l * 12.92 : 1.055 * pow(l, 1.0 / 2.4) - 0.055;
}
float4 ps(VO i) : SV_Target {
    float3 c = tex.Sample(smp, i.uv).rgb * scale;            // scRGB -> 1.0 = your SDR white
    float y = dot(c, float3(0.2126, 0.7152, 0.0722));
    float mn = min(min(c.r, c.g), c.b);
    if (mn < 0 && y > 0) c = lerp(y.xxx, c, y / (y - mn));   // wide-gamut colours: desaturate, don't clip
    c = rolloff(max(c, 0));
    return float4(toSrgb(c), 1);
}";

    // Second stage: tone-mapped sRGB (BGRA texture) -> NV12 planes, BT.709 limited range.
    // psUV runs at half resolution and samples between 4 texels, so bilinear filtering averages each 2x2 block.
    const string HLSL_NV12 = @"
Texture2D img : register(t0);
SamplerState smp : register(s0);
struct VO { float4 pos : SV_Position; float2 uv : TEXCOORD0; };
static const float3 KY = float3(0.2126, 0.7152, 0.0722);
float psY(VO i) : SV_Target {
    float3 c = img.Load(int3(i.pos.xy, 0)).rgb;
    return (16.0 + 219.0 * dot(c, KY)) / 255.0;
}
float2 psUV(VO i) : SV_Target {
    float3 c = img.Sample(smp, i.uv).rgb;
    float y = dot(c, KY);
    return float2(128.0 + 224.0 * (c.b - y) / 1.8556, 128.0 + 224.0 * (c.r - y) / 1.5748) / 255.0;
}";

    static IntPtr Compile(string hlsl, string entry, string target)
    {
        byte[] src = Encoding.ASCII.GetBytes(hlsl);
        IntPtr code, errors;
        int hr = D3DCompile(src, (IntPtr)src.Length, "hdrfix", IntPtr.Zero, IntPtr.Zero, entry, target, 1u << 15, 0, out code, out errors);
        if (hr < 0)
        {
            string msg = errors != IntPtr.Zero ? Marshal.PtrToStringAnsi(Fn<BlobFn>(errors, 3)(errors)) : "";
            throw new Exception("D3DCompile " + entry + ": " + msg);
        }
        Rel(ref errors);
        return code;
    }

    sealed class ToneMapper
    {
        IntPtr dev, ctx, vs, ps, psY, psUV, sampler, cbuf;
        IntPtr copyTex, srv, rt, rtv, rtSrv, yTex, yRtv, uvTex, uvRtv, yStaging, uvStaging, bgraStaging;
        /** Screenshots: output full-quality BGRA (no chroma subsampling) instead of NV12. */
        public bool Bgra;
        bool mips;
        readonly int maxW, maxH;
        public int SrcW, SrcH, DstW, DstH;
        public byte[] Frame;
        readonly float[] cb = new float[4];

        readonly CopyRegionFn copyRegion; readonly CopyFn copy; readonly SetPtrFn genMips; readonly UpdateSubFn updateSub;
        readonly SetArrFn psSRV, psSmp, psCB; readonly SetShaderFn psSet, vsSet; readonly DrawFn draw;
        readonly MapFn map; readonly UnmapFn unmap; readonly SetPtrFn setLayout; readonly SetUIntFn setTopo;
        readonly OMSetRTFn omSet; readonly ViewportsFn setVp;

        public ToneMapper(IntPtr device, IntPtr context, int maxWidth, int maxHeight, double sdrWhite, double peakNits, double knee)
        {
            dev = device; ctx = context; maxW = maxWidth; maxH = maxHeight;

            IntPtr vsCode = Compile(HLSL, "vs", "vs_4_0");
            Check(Fn<CreateShaderFn>(dev, 12)(dev, Fn<BlobFn>(vsCode, 3)(vsCode), Fn<BlobFn>(vsCode, 4)(vsCode), IntPtr.Zero, out vs), "CreateVertexShader");
            Rel(ref vsCode);
            ps = PixelShader(HLSL, "ps"); psY = PixelShader(HLSL_NV12, "psY"); psUV = PixelShader(HLSL_NV12, "psUV");

            var sd = new SAMPLER_DESC(); sd.Filter = 0x15; sd.AddressU = sd.AddressV = sd.AddressW = 3;
            sd.MaxAnisotropy = 1; sd.ComparisonFunc = 1; sd.MaxLOD = float.MaxValue;
            Check(Fn<CreateSamplerFn>(dev, 23)(dev, ref sd, out sampler), "CreateSamplerState");

            Fill(sdrWhite, peakNits, knee);
            GCHandle h = GCHandle.Alloc(cb, GCHandleType.Pinned);
            try
            {
                var bd = new BUFFER_DESC(); bd.ByteWidth = 16; bd.BindFlags = 4;
                var init = new SUBRESOURCE_DATA(); init.pSysMem = h.AddrOfPinnedObject(); init.SysMemPitch = 16;
                Check(Fn<CreateBufferFn>(dev, 3)(dev, ref bd, ref init, out cbuf), "CreateBuffer");
            }
            finally { h.Free(); }

            copyRegion = Fn<CopyRegionFn>(ctx, 46); copy = Fn<CopyFn>(ctx, 47); genMips = Fn<SetPtrFn>(ctx, 54); updateSub = Fn<UpdateSubFn>(ctx, 48);
            psSRV = Fn<SetArrFn>(ctx, 8); psSmp = Fn<SetArrFn>(ctx, 10); psCB = Fn<SetArrFn>(ctx, 16);
            psSet = Fn<SetShaderFn>(ctx, 9); vsSet = Fn<SetShaderFn>(ctx, 11); draw = Fn<DrawFn>(ctx, 13);
            map = Fn<MapFn>(ctx, 14); unmap = Fn<UnmapFn>(ctx, 15); setLayout = Fn<SetPtrFn>(ctx, 17); setTopo = Fn<SetUIntFn>(ctx, 24);
            omSet = Fn<OMSetRTFn>(ctx, 33); setVp = Fn<ViewportsFn>(ctx, 44);
        }

        IntPtr PixelShader(string hlsl, string entry)
        {
            IntPtr code = Compile(hlsl, entry, "ps_4_0"), shader;
            try { Check(Fn<CreateShaderFn>(dev, 15)(dev, Fn<BlobFn>(code, 3)(code), Fn<BlobFn>(code, 4)(code), IntPtr.Zero, out shader), "CreatePixelShader(" + entry + ")"); }
            finally { Rel(ref code); }
            return shader;
        }

        IntPtr Texture(int w, int h, int format, uint bind, bool staging)
        {
            var d = new TEX2D_DESC(); d.Width = (uint)w; d.Height = (uint)h; d.MipLevels = 1; d.ArraySize = 1;
            d.Format = (uint)format; d.SampleCount = 1; d.BindFlags = bind;
            if (staging) { d.Usage = 3; d.CPUAccessFlags = 0x20000; }
            IntPtr t;
            Check(Fn<CreateTex2DFn>(dev, 5)(dev, ref d, IntPtr.Zero, out t), "CreateTexture2D(" + format + ")");
            return t;
        }

        IntPtr View(int slot, IntPtr resource)
        {
            IntPtr v;
            Check(Fn<CreateViewFn>(dev, slot)(dev, resource, IntPtr.Zero, out v), slot == 7 ? "CreateShaderResourceView" : "CreateRenderTargetView");
            return v;
        }

        void Fill(double sdrWhite, double peakNits, double knee)
        {
            if (sdrWhite <= 0) sdrWhite = 80;
            cb[0] = (float)(80.0 / sdrWhite); cb[1] = (float)(peakNits / sdrWhite); cb[2] = (float)knee; cb[3] = 0;
        }

        public void SetParams(double sdrWhite, double peakNits, double knee)
        {
            Fill(sdrWhite, peakNits, knee);
            GCHandle h = GCHandle.Alloc(cb, GCHandleType.Pinned);
            try { updateSub(ctx, cbuf, 0, IntPtr.Zero, h.AddrOfPinnedObject(), 16, 16); }
            finally { h.Free(); }
        }

        void Resize(int w, int h)
        {
            ReleaseTargets();
            SrcW = w; SrcH = h;
            double s = Math.Min(1.0, Math.Min((double)maxW / w, (double)maxH / h));
            DstW = Math.Max(2, (int)(w * s) & ~1); DstH = Math.Max(2, (int)(h * s) & ~1);
            mips = DstW < w;

            var cd = new TEX2D_DESC(); cd.Width = (uint)w; cd.Height = (uint)h; cd.MipLevels = mips ? 0u : 1u; cd.ArraySize = 1;
            cd.Format = FMT_FP16; cd.SampleCount = 1; cd.BindFlags = 0x8 | 0x20; cd.MiscFlags = mips ? 1u : 0u;
            Check(Fn<CreateTex2DFn>(dev, 5)(dev, ref cd, IntPtr.Zero, out copyTex), "CreateTexture2D(copy)");
            srv = View(7, copyTex);

            // tone-mapped sRGB at stream size, then its NV12 planes and their CPU-readable copies
            rt = Texture(DstW, DstH, FMT_BGRA8, 0x20 | 0x8, false); rtv = View(9, rt); rtSrv = View(7, rt);
            if (Bgra)
            {
                bgraStaging = Texture(DstW, DstH, FMT_BGRA8, 0, true);
                Frame = new byte[16 + DstW * DstH * 4];
                WriteHeader();
                return;
            }
            yTex = Texture(DstW, DstH, FMT_R8, 0x20, false); yRtv = View(9, yTex);
            uvTex = Texture(DstW / 2, DstH / 2, FMT_R8G8, 0x20, false); uvRtv = View(9, uvTex);
            yStaging = Texture(DstW, DstH, FMT_R8, 0, true);
            uvStaging = Texture(DstW / 2, DstH / 2, FMT_R8G8, 0, true);

            Frame = new byte[16 + DstW * DstH * 3 / 2];
            WriteHeader();
        }

        void WriteHeader()
        {
            Encoding.ASCII.GetBytes("HDRF").CopyTo(Frame, 0);
            BitConverter.GetBytes((uint)DstW).CopyTo(Frame, 4);
            BitConverter.GetBytes((uint)DstH).CopyTo(Frame, 8);
        }

        // Tone-maps the top-left w x h region of an FP16 texture into Frame.
        public void Process(IntPtr srcTex, int w, int h)
        {
            if (w != SrcW || h != SrcH) Resize(w, h);

            var box = new BOX(); box.Right = (uint)w; box.Bottom = (uint)h; box.Back = 1;
            copyRegion(ctx, copyTex, 0, 0, 0, 0, srcTex, 0, ref box);

            psSRV(ctx, 0, 1, new IntPtr[] { IntPtr.Zero });
            if (mips) genMips(ctx, srv);
            var vp = new VIEWPORT(); vp.W = DstW; vp.H = DstH; vp.MaxDepth = 1;
            omSet(ctx, 1, new IntPtr[] { rtv }, IntPtr.Zero);
            setVp(ctx, 1, ref vp);
            setLayout(ctx, IntPtr.Zero); setTopo(ctx, 4);
            vsSet(ctx, vs, IntPtr.Zero, 0); psSet(ctx, ps, IntPtr.Zero, 0);
            psSRV(ctx, 0, 1, new IntPtr[] { srv }); psSmp(ctx, 0, 1, new IntPtr[] { sampler }); psCB(ctx, 0, 1, new IntPtr[] { cbuf });
            draw(ctx, 3, 0);

            if (Bgra)
            {
                omSet(ctx, 1, NoViews, IntPtr.Zero);
                copy(ctx, bgraStaging, rt);
                ReadPlane(bgraStaging, 16, DstH, DstW * 4);
                return;
            }

            // RGB -> NV12 while still on the GPU
            psSRV(ctx, 0, 1, NoViews);
            omSet(ctx, 1, new IntPtr[] { yRtv }, IntPtr.Zero);
            psSet(ctx, psY, IntPtr.Zero, 0);
            psSRV(ctx, 0, 1, new IntPtr[] { rtSrv });
            draw(ctx, 3, 0);

            var half = vp; half.W = DstW / 2; half.H = DstH / 2;
            psSRV(ctx, 0, 1, NoViews);
            omSet(ctx, 1, new IntPtr[] { uvRtv }, IntPtr.Zero);
            setVp(ctx, 1, ref half);
            psSet(ctx, psUV, IntPtr.Zero, 0);
            psSRV(ctx, 0, 1, new IntPtr[] { rtSrv });
            draw(ctx, 3, 0);

            psSRV(ctx, 0, 1, NoViews);
            omSet(ctx, 1, NoViews, IntPtr.Zero);
            copy(ctx, yStaging, yTex);
            copy(ctx, uvStaging, uvTex);

            ReadPlane(yStaging, 16, DstH, DstW);
            ReadPlane(uvStaging, 16 + DstW * DstH, DstH / 2, DstW);   // DstW/2 UV pairs = DstW bytes per row
        }

        static readonly IntPtr[] NoViews = { IntPtr.Zero };

        void ReadPlane(IntPtr staging, int offset, int rows, int rowBytes)
        {
            MAPPED m;
            Check(map(ctx, staging, 0, 1, 0, out m), "Map");
            try
            {
                if (m.RowPitch == rowBytes) Marshal.Copy(m.pData, Frame, offset, rowBytes * rows);
                else for (int y = 0; y < rows; y++) Marshal.Copy(IntPtr.Add(m.pData, y * (int)m.RowPitch), Frame, offset + y * rowBytes, rowBytes);
            }
            finally { unmap(ctx, staging, 0); }
        }

        void ReleaseTargets()
        {
            Rel(ref bgraStaging); Rel(ref uvStaging); Rel(ref yStaging); Rel(ref uvRtv); Rel(ref uvTex); Rel(ref yRtv); Rel(ref yTex);
            Rel(ref rtSrv); Rel(ref rtv); Rel(ref rt); Rel(ref srv); Rel(ref copyTex);
        }

        public void Dispose()
        {
            ReleaseTargets();
            Rel(ref cbuf); Rel(ref sampler); Rel(ref psUV); Rel(ref psY); Rel(ref ps); Rel(ref vs);
        }
    }

    // =====================================================================================
    // Cursor (monitor capture only — Windows.Graphics.Capture draws it for windows)
    // =====================================================================================
    static byte[] curShape = new byte[0];
    static POINTER_SHAPE_INFO curInfo;
    static int curX, curY;
    static bool curVisible;

    // BT.709 limited range, matching the GPU shader
    static byte Clamp(double v) { return (byte)(v < 0 ? 0 : v > 255 ? 255 : Math.Round(v)); }
    static void Yuv(int r, int g, int b, out byte y, out byte u, out byte v)
    {
        double yn = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255.0;
        y = Clamp(16 + 219 * yn);
        u = Clamp(128 + 224 * (b / 255.0 - yn) / 1.8556);
        v = Clamp(128 + 224 * (r / 255.0 - yn) / 1.5748);
    }

    // Draws the cursor into an NV12 frame. Chroma is written at even pixels (one UV pair per 2x2 block).
    static void DrawCursor(byte[] frame, int off, int fw, int fh, double sx, double sy)
    {
        if (!curVisible || curShape.Length == 0) return;
        bool mono = curInfo.Type == 1;
        int cw = (int)curInfo.Width, ch = mono ? (int)curInfo.Height / 2 : (int)curInfo.Height, pitch = (int)curInfo.Pitch;
        if (cw <= 0 || ch <= 0) return;
        int dw = Math.Max(1, (int)Math.Round(cw * sx)), dh = Math.Max(1, (int)Math.Round(ch * sy));
        int ox = (int)Math.Round(curX * sx), oy = (int)Math.Round(curY * sy);
        int uvBase = off + fw * fh;
        for (int y = 0; y < dh; y++)
        {
            int fy = oy + y; if (fy < 0 || fy >= fh) continue;
            int syy = Math.Min(ch - 1, (int)(y / sy));
            for (int x = 0; x < dw; x++)
            {
                int fx = ox + x; if (fx < 0 || fx >= fw) continue;
                int sxx = Math.Min(cw - 1, (int)(x / sx));
                int py = off + fy * fw + fx;
                bool chroma = (fx & 1) == 0 && (fy & 1) == 0;
                int pu = uvBase + (fy >> 1) * fw + (fx & ~1);

                // op: 0 = leave, 1 = replace with (cy,cu,cv) at alpha a, 2 = invert
                int op = 0, a = 255; byte cy = 0, cu = 128, cv = 128;
                if (mono)
                {
                    int bit = 0x80 >> (sxx & 7);
                    bool and = (curShape[syy * pitch + sxx / 8] & bit) != 0;
                    bool xor = (curShape[(syy + ch) * pitch + sxx / 8] & bit) != 0;
                    if (!and) { op = 1; cy = xor ? (byte)235 : (byte)16; }
                    else if (xor) op = 2;
                }
                else
                {
                    int s = syy * pitch + sxx * 4;
                    a = curShape[s + 3];
                    bool colored = curShape[s] != 0 || curShape[s + 1] != 0 || curShape[s + 2] != 0;
                    if (curInfo.Type == 4) { if (a == 0) { op = 1; a = 255; } else if (colored) op = 2; }   // masked colour: 0 = replace, FF = XOR
                    else if (a != 0) op = 1;
                    if (op == 1) Yuv(curShape[s + 2], curShape[s + 1], curShape[s], out cy, out cu, out cv);
                }

                if (op == 1)
                {
                    frame[py] = (byte)((cy * a + frame[py] * (255 - a)) / 255);
                    if (chroma)
                    {
                        frame[pu] = (byte)((cu * a + frame[pu] * (255 - a)) / 255);
                        frame[pu + 1] = (byte)((cv * a + frame[pu + 1] * (255 - a)) / 255);
                    }
                }
                else if (op == 2)
                {
                    frame[py] = (byte)(251 - Math.Min(235, Math.Max(16, (int)frame[py])));   // 16+235-Y
                    if (chroma) { frame[pu] = (byte)(256 - Math.Max(1, (int)frame[pu])); frame[pu + 1] = (byte)(256 - Math.Max(1, (int)frame[pu + 1])); }
                }
            }
        }
    }

    // NV12 (BT.709 limited) -> BGRA, used by the self-test to save a PNG.
    public static byte[] Nv12ToBgra(byte[] src, int offset, int w, int h)
    {
        var dst = new byte[w * h * 4];
        int uvBase = offset + w * h;
        for (int y = 0; y < h; y++)
            for (int x = 0; x < w; x++)
            {
                double yn = (src[offset + y * w + x] - 16) / 219.0;
                int pu = uvBase + (y >> 1) * w + (x & ~1);
                double un = (src[pu] - 128) / 224.0, vn = (src[pu + 1] - 128) / 224.0;
                int p = (y * w + x) * 4;
                dst[p + 2] = Clamp(255 * (yn + 1.5748 * vn));
                dst[p + 1] = Clamp(255 * (yn - 0.468125 * vn - 0.187324 * un));
                dst[p] = Clamp(255 * (yn + 1.8556 * un));
                dst[p + 3] = 255;
            }
        return dst;
    }

    // =====================================================================================
    // Shared helpers
    // =====================================================================================
    static volatile bool quit;
    static uint seq;

    // Snapshot mode (screenshots): the capture loops stop after the first frame and keep it here.
    static volatile bool snapshot;
    static byte[] snapFrame;

    static void Prepare()
    {
        try { if (!SetProcessDpiAwarenessContext((IntPtr)(-4))) SetThreadDpiAwarenessContext((IntPtr)(-4)); } catch { }
        if (snapshot) return;
        // Exit when Vesktop closes our stdin (or dies).
        var stdinWatch = new Thread(delegate () { try { Console.OpenStandardInput().CopyTo(Stream.Null); } catch { } quit = true; });
        stdinWatch.IsBackground = true; stdinWatch.Start();
    }

    static bool Emit(Stream stdout, byte[] frame)
    {
        if (snapshot) { snapFrame = (byte[])frame.Clone(); quit = true; return true; }
        BitConverter.GetBytes(++seq).CopyTo(frame, 12);
        try { stdout.Write(frame, 0, frame.Length); stdout.Flush(); return true; }
        catch { return false; }   // Vesktop went away
    }

    static void Log(string kind, string detail)
    {
        string d = detail.StartsWith("{") ? detail : "\"" + Esc(detail) + "\"";
        Console.Error.WriteLine("{\"kind\":\"" + kind + "\",\"detail\":" + d + "}");
        Console.Error.Flush();
    }

    static string Num(double v) { return v.ToString(INV); }

    // =====================================================================================
    // Monitor capture (DXGI Desktop Duplication, FP16)
    // =====================================================================================
    public static void Run(int adapterIndex, int outputIndex, int maxW, int maxH, int fps, double knee, double peakNitsOverride, double sdrWhiteOverride)
    {
        Prepare();

        IntPtr adapter = IntPtr.Zero, output6 = IntPtr.Zero; OutputInfo info = null;
        Walk(delegate (IntPtr ad, IntPtr o6, OutputInfo i)
        {
            if (i.Adapter != adapterIndex || i.Output != outputIndex) return false;
            adapter = ad; output6 = o6; info = i; return true;
        });
        if (info == null) throw new Exception("monitor " + adapterIndex + ":" + outputIndex + " not found");

        double sdrWhite = sdrWhiteOverride > 0 ? sdrWhiteOverride : info.SdrWhite;
        double peakNits = peakNitsOverride > 0 ? peakNitsOverride : (info.MaxNits > 0 ? info.MaxNits : 1000);

        IntPtr dev, ctx; int level;
        Check(D3D11CreateDevice(adapter, 0, IntPtr.Zero, 0x20, IntPtr.Zero, 0, 7, out dev, out level, out ctx), "D3D11CreateDevice");
        var tm = new ToneMapper(dev, ctx, maxW, maxH, sdrWhite, peakNits, knee);
        tm.Bgra = snapshot;

        IntPtr dup = IntPtr.Zero;
        IntPtr frameInfo = Marshal.AllocHGlobal(48);
        Stream stdout = Console.OpenStandardOutput();
        var clock = Stopwatch.StartNew();
        double interval = 1000.0 / Math.Max(1, fps), nextDue = 0;
        bool announced = false;

        while (!quit)
        {
            if (dup == IntPtr.Zero)
            {
                int hr = Fn<DuplicateOutput1Fn>(output6, 26)(output6, dev, 0, 1, new int[] { FMT_FP16 }, out dup);
                if (hr < 0)
                {
                    dup = IntPtr.Zero;
                    // UNSUPPORTED / INVALID_CALL / E_INVALIDARG won't fix themselves: fail fast so Vesktop falls back.
                    if (tm.Frame == null && (hr == unchecked((int)0x887A0004) || hr == unchecked((int)0x887A0001) || hr == unchecked((int)0x80070057)))
                        throw new Exception("DuplicateOutput1 failed: 0x" + hr.ToString("X8"));
                    Log("waiting", "DuplicateOutput1 0x" + hr.ToString("X8"));   // e.g. UAC/secure desktop showing
                    Thread.Sleep(500); continue;
                }
            }

            double wait = nextDue - clock.Elapsed.TotalMilliseconds;
            if (wait > 1) Thread.Sleep((int)wait);

            IntPtr res;
            int ar = Fn<AcquireFn>(dup, 8)(dup, (uint)Math.Max(1, interval), frameInfo, out res);
            if (ar == WAIT_TIMEOUT) continue;
            if (ar < 0) { Rel(ref dup); Thread.Sleep(100); continue; }   // ACCESS_LOST: mode change, UAC, fullscreen switch...

            long presentTime = Marshal.ReadInt64(frameInfo, 0), mouseTime = Marshal.ReadInt64(frameInfo, 8);
            bool newImage = presentTime != 0 || tm.Frame == null;
            IntPtr tex = IntPtr.Zero;
            try
            {
                if (mouseTime != 0)
                {
                    curVisible = Marshal.ReadInt32(frameInfo, 36) != 0;
                    if (curVisible) { curX = Marshal.ReadInt32(frameInfo, 28); curY = Marshal.ReadInt32(frameInfo, 32); }
                    uint shapeSize = (uint)Marshal.ReadInt32(frameInfo, 44);
                    if (shapeSize > 0)
                    {
                        IntPtr sbuf = Marshal.AllocHGlobal((int)shapeSize); uint req; POINTER_SHAPE_INFO psi;
                        if (Fn<PointerShapeFn>(dup, 11)(dup, shapeSize, sbuf, out req, out psi) >= 0)
                        {
                            curInfo = psi; curShape = new byte[shapeSize]; Marshal.Copy(sbuf, curShape, 0, (int)shapeSize);
                        }
                        Marshal.FreeHGlobal(sbuf);
                    }
                }
                if (newImage)
                {
                    tex = QI(res, IID_Tex2D);
                    TEX2D_DESC td; Fn<TexGetDescFn>(tex, 10)(tex, out td);
                    tm.Process(tex, (int)td.Width, (int)td.Height);
                }
            }
            finally
            {
                Rel(ref tex); Rel(ref res);
                Fn<NoArgFn>(dup, 14)(dup);   // ReleaseFrame
            }
            if (tm.Frame == null || (!newImage && mouseTime == 0)) continue;

            // Cursor goes on a copy so the next mouse-only update starts from a clean image.
            byte[] outFrame = tm.Frame;
            if (!snapshot && curVisible && curShape.Length > 0)   // screenshots leave the cursor out
            {
                outFrame = (byte[])tm.Frame.Clone();
                DrawCursor(outFrame, 16, tm.DstW, tm.DstH, (double)tm.DstW / tm.SrcW, (double)tm.DstH / tm.SrcH);
            }
            if (!Emit(stdout, outFrame)) break;

            if (!announced)
            {
                announced = true;
                Log("started", "{\"kind\":\"screen\",\"name\":\"" + Esc(info.Name) + "\",\"src\":\"" + tm.SrcW + "x" + tm.SrcH + "\",\"dst\":\"" + tm.DstW + "x" + tm.DstH +
                    "\",\"sdrWhite\":" + Num(sdrWhite) + ",\"peak\":" + Num(peakNits) + ",\"hdr\":" + (info.Hdr ? "true" : "false") + "}");
            }
            nextDue = Math.Max(nextDue + interval, clock.Elapsed.TotalMilliseconds - interval);
        }

        tm.Dispose(); Rel(ref dup);
        Rel(ref ctx); Rel(ref dev); Rel(ref output6); Rel(ref adapter);
        Marshal.FreeHGlobal(frameInfo);
    }

    // =====================================================================================
    // Window capture (Windows.Graphics.Capture, FP16 frame pool)
    // =====================================================================================
    static string MonitorOf(IntPtr hwnd)
    {
        var mi = new MONITORINFOEX(); mi.cbSize = Marshal.SizeOf(typeof(MONITORINFOEX));
        return GetMonitorInfoW(MonitorFromWindow(hwnd, 2 /* NEAREST */), ref mi) ? mi.szDevice : "";
    }

    public static void RunWindow(long hwndValue, int maxW, int maxH, int fps, double knee, double peakNitsOverride, double sdrWhiteOverride)
    {
        Prepare();
        IntPtr hwnd = new IntPtr(hwndValue);
        if (!IsWindow(hwnd)) throw new Exception("window " + hwndValue + " no longer exists");

        // Tone-map for the monitor the window is on; re-checked while running in case it moves.
        string monName = MonitorOf(hwnd);
        OutputInfo mon = FindOutput(monName);
        Func<OutputInfo, double> sdrOf = delegate (OutputInfo o) { return sdrWhiteOverride > 0 ? sdrWhiteOverride : (o != null ? o.SdrWhite : 80); };
        Func<OutputInfo, double> peakOf = delegate (OutputInfo o) { return peakNitsOverride > 0 ? peakNitsOverride : (o != null && o.MaxNits > 0 ? o.MaxNits : 1000); };

        IntPtr dev, ctx; int level;
        Check(D3D11CreateDevice(IntPtr.Zero, 1 /* HARDWARE */, IntPtr.Zero, 0x20, IntPtr.Zero, 0, 7, out dev, out level, out ctx), "D3D11CreateDevice");
        var tm = new ToneMapper(dev, ctx, maxW, maxH, sdrOf(mon), peakOf(mon), knee);
        tm.Bgra = snapshot;

        IntPtr dxgiDev = QI(dev, IID_DXGIDevice), insp, d3dDevice;
        Check(CreateDirect3D11DeviceFromDXGIDevice(dxgiDev, out insp), "CreateDirect3D11DeviceFromDXGIDevice");
        d3dDevice = QI(insp, IID_D3DDevice);
        Rel(ref insp); Rel(ref dxgiDev);

        IntPtr interop = Factory("Windows.Graphics.Capture.GraphicsCaptureItem", IID_ItemInterop);
        Guid itemIid = IID_Item; IntPtr item;
        Check(Fn<CreateForWindowFn>(interop, 3)(interop, hwnd, ref itemIid, out item), "CreateForWindow");
        Rel(ref interop);

        SIZE32 poolSize;
        Check(Fn<GetSizeFn>(item, 7)(item, out poolSize), "GraphicsCaptureItem.Size");
        if (poolSize.Width < 1) poolSize.Width = 1;
        if (poolSize.Height < 1) poolSize.Height = 1;

        IntPtr statics = Factory("Windows.Graphics.Capture.Direct3D11CaptureFramePool", IID_PoolStatics2);
        IntPtr pool;
        Check(Fn<CreateFreeThreadedFn>(statics, 6)(statics, d3dDevice, FMT_FP16, 2, poolSize, out pool), "CreateFreeThreaded");
        Rel(ref statics);

        IntPtr session;
        Check(Fn<CreateSessionFn>(pool, 10)(pool, item, out session), "CreateCaptureSession");
        IntPtr s2 = TryQI(session, IID_Session2);
        if (s2 != IntPtr.Zero) { Fn<SetBoolFn>(s2, 7)(s2, !snapshot); Rel(ref s2); }    // cursor on streams, off on screenshots
        IntPtr s3 = TryQI(session, IID_Session3);
        if (s3 != IntPtr.Zero) { Fn<SetBoolFn>(s3, 7)(s3, false); Rel(ref s3); }   // no yellow border (ignored if not allowed)
        Check(Fn<NoArgFn>(session, 6)(session), "StartCapture");

        Stream stdout = Console.OpenStandardOutput();
        var clock = Stopwatch.StartNew();
        double interval = 1000.0 / Math.Max(1, fps), nextDue = 0, nextCheck = 1000;
        bool announced = false;
        var title = new StringBuilder(256);
        GetWindowTextW(hwnd, title, 256);

        while (!quit)
        {
            double now = clock.Elapsed.TotalMilliseconds;
            if (now >= nextCheck)
            {
                nextCheck = now + 1000;
                if (!IsWindow(hwnd)) { Log("ended", "window closed"); break; }
                string m = MonitorOf(hwnd);
                if (m != monName)
                {
                    monName = m; mon = FindOutput(m);
                    tm.SetParams(sdrOf(mon), peakOf(mon), knee);
                    Log("monitor", m);
                }
            }

            double wait = nextDue - clock.Elapsed.TotalMilliseconds;
            Thread.Sleep(wait > 1 ? (int)wait : 1);

            // Drain the pool, keep only the newest frame.
            IntPtr frame = IntPtr.Zero, next;
            while (Fn<OutPtrFn>(pool, 7)(pool, out next) >= 0 && next != IntPtr.Zero)
            {
                Close(ref frame);
                frame = next;
            }
            if (frame == IntPtr.Zero) continue;   // window didn't change

            IntPtr surface = IntPtr.Zero, access = IntPtr.Zero, tex = IntPtr.Zero;
            bool produced = false;
            try
            {
                SIZE32 content;
                Check(Fn<GetSizeFn>(frame, 8)(frame, out content), "ContentSize");
                Check(Fn<OutPtrFn>(frame, 6)(frame, out surface), "Surface");
                access = QI(surface, IID_DxgiAccess);
                Guid texIid = IID_Tex2D;
                Check(Fn<GetInterfaceFn>(access, 3)(access, ref texIid, out tex), "GetInterface(Texture2D)");
                TEX2D_DESC td; Fn<TexGetDescFn>(tex, 10)(tex, out td);

                int w = Math.Min(content.Width, (int)td.Width), h = Math.Min(content.Height, (int)td.Height);
                if (w >= 2 && h >= 2)   // minimised windows report a tiny/zero size
                {
                    tm.Process(tex, w, h);
                    produced = true;
                }
                if (content.Width != poolSize.Width || content.Height != poolSize.Height)
                {
                    if (content.Width >= 1 && content.Height >= 1)
                    {
                        poolSize = content;
                        Fn<RecreateFn>(pool, 6)(pool, d3dDevice, FMT_FP16, 2, poolSize);   // window was resized
                    }
                }
            }
            finally
            {
                Rel(ref tex); Rel(ref access); Rel(ref surface);
                Close(ref frame);
            }
            if (!produced) continue;
            if (!Emit(stdout, tm.Frame)) break;

            if (!announced)
            {
                announced = true;
                Log("started", "{\"kind\":\"window\",\"name\":\"" + Esc(title.ToString()) + "\",\"monitor\":\"" + Esc(monName) + "\",\"src\":\"" + tm.SrcW + "x" + tm.SrcH +
                    "\",\"dst\":\"" + tm.DstW + "x" + tm.DstH + "\",\"sdrWhite\":" + Num(sdrOf(mon)) + ",\"peak\":" + Num(peakOf(mon)) +
                    ",\"hdr\":" + (mon != null && mon.Hdr ? "true" : "false") + "}");
            }
            nextDue = Math.Max(nextDue + interval, clock.Elapsed.TotalMilliseconds - interval);
        }

        Close(ref session); Close(ref pool); Rel(ref item); Close(ref d3dDevice);
        tm.Dispose(); Rel(ref ctx); Rel(ref dev);
    }
    // =====================================================================================
    // Screenshots: one tone-mapped frame at full resolution, as top-down BGRA
    // =====================================================================================
    static readonly object snapLock = new object();

    static byte[] Snap(ThreadStart capture, out int width, out int height)
    {
        lock (snapLock)
        {
            snapshot = true; quit = false; snapFrame = null;
            // Give up if no frame arrives (e.g. a minimised window never draws).
            var watchdog = new Timer(delegate (object o) { quit = true; }, null, 4000, Timeout.Infinite);
            try { capture(); }
            finally { watchdog.Dispose(); snapshot = false; quit = false; }
            if (snapFrame == null) throw new Exception("no image arrived (is the window minimised?)");
            width = (int)BitConverter.ToUInt32(snapFrame, 4);
            height = (int)BitConverter.ToUInt32(snapFrame, 8);
            var pixels = new byte[snapFrame.Length - 16];
            Buffer.BlockCopy(snapFrame, 16, pixels, 0, pixels.Length);
            snapFrame = null;
            return pixels;
        }
    }

    /** Screenshot of the monitor containing the physical-pixel point (x, y). */
    public static byte[] SnapshotMonitorAt(int x, int y, double knee, double peakNits, double sdrWhite, out int width, out int height, out string name)
    {
        string device = HdrDisplays.DeviceAt(x, y);
        OutputInfo target = null;
        Walk(delegate (IntPtr ad, IntPtr o6, OutputInfo i)
        {
            if (target == null && string.Equals(i.Name, device, StringComparison.OrdinalIgnoreCase)) target = i;
            return false;
        });
        if (target == null) throw new Exception("monitor " + device + " not found");
        name = target.Name;
        OutputInfo t = target;
        return Snap(delegate () { Run(t.Adapter, t.Output, 16384, 16384, 60, knee, peakNits, sdrWhite); }, out width, out height);
    }

    /** Screenshot of a single window (without the cursor). */
    public static byte[] SnapshotWindow(long hwnd, double knee, double peakNits, double sdrWhite, out int width, out int height)
    {
        return Snap(delegate () { RunWindow(hwnd, 16384, 16384, 60, knee, peakNits, sdrWhite); }, out width, out height);
    }
}
`;
