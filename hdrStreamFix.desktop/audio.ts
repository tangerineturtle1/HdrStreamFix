/*
 * HdrStreamFix — per-app audio for window shares (C#, compiled with the rest of the helper).
 *
 * Captures ONLY the audio of the shared window's process tree using Windows' process-loopback
 * capture (Windows 10 2004+, INCLUDE_TARGET_PROCESS_TREE). Voice chat, music and other apps are
 * never in it, so viewers can't hear themselves — even with Voicemeeter/Sonar or a second Discord.
 *
 * The process-loopback device can't report a format, so we ask for 48 kHz stereo float32 and let
 * Windows convert (AUTOCONVERTPCM), the same approach as Microsoft's ApplicationLoopback sample.
 * Output on stdout: [ "HDRA" | frames u32 | 0 u32 | seq u32 ] + frames*2 float32 (interleaved).
 * Interface GUIDs and vtable slots checked against Microsoft's windows-rs metadata.
 */

export const AUDIO_CS = String.raw`
[ComImport, Guid("72a22d78-cde4-431d-b8cc-843a71199b6d"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IActivateAudioInterfaceAsyncOperation { void GetActivateResult(out int activateResult, out IntPtr activatedInterface); }

[ComImport, Guid("41d949ab-9862-444a-80f6-c261334da5eb"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IActivateAudioInterfaceCompletionHandler { void ActivateCompleted(IActivateAudioInterfaceAsyncOperation operation); }

// Marks the handler as callable from any thread (required by ActivateAudioInterfaceAsync).
[ComImport, Guid("94ea2b94-e9cc-49e0-c0ff-ee64ca8f5b90"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IAgileObject { }

public class HdrAudioActivation : IActivateAudioInterfaceCompletionHandler, IAgileObject
{
    public readonly ManualResetEvent Done = new ManualResetEvent(false);
    public int Result = unchecked((int)0x80004005);
    public IntPtr Client = IntPtr.Zero;

    public void ActivateCompleted(IActivateAudioInterfaceAsyncOperation operation)
    {
        int hr; IntPtr client;
        operation.GetActivateResult(out hr, out client);
        Result = hr; Client = client;
        Done.Set();
    }
}

public static class HdrAudio
{
    [UnmanagedFunctionPointer(CallingConvention.StdCall)] delegate uint ReleaseFn(IntPtr self);
    [UnmanagedFunctionPointer(CallingConvention.StdCall)] delegate int InitializeFn(IntPtr self, int shareMode, uint flags, long bufferDuration, long periodicity, IntPtr format, IntPtr sessionGuid);
    [UnmanagedFunctionPointer(CallingConvention.StdCall)] delegate int NoArgFn(IntPtr self);
    [UnmanagedFunctionPointer(CallingConvention.StdCall)] delegate int SetEventFn(IntPtr self, IntPtr handle);
    [UnmanagedFunctionPointer(CallingConvention.StdCall)] delegate int GetServiceFn(IntPtr self, ref Guid iid, out IntPtr service);
    [UnmanagedFunctionPointer(CallingConvention.StdCall)] delegate int GetBufferFn(IntPtr self, out IntPtr data, out uint frames, out uint flags, IntPtr devicePosition, IntPtr qpcPosition);
    [UnmanagedFunctionPointer(CallingConvention.StdCall)] delegate int ReleaseBufferFn(IntPtr self, uint frames);
    [UnmanagedFunctionPointer(CallingConvention.StdCall)] delegate int PacketSizeFn(IntPtr self, out uint frames);

    static T Fn<T>(IntPtr obj, int slot) where T : class
    {
        IntPtr vtbl = Marshal.ReadIntPtr(obj);
        return (T)(object)Marshal.GetDelegateForFunctionPointer(Marshal.ReadIntPtr(vtbl, slot * IntPtr.Size), typeof(T));
    }
    static void Check(int hr, string what) { if (hr < 0) throw new Exception(what + " failed: 0x" + hr.ToString("X8")); }
    static void Rel(ref IntPtr p) { if (p != IntPtr.Zero) { Fn<ReleaseFn>(p, 2)(p); p = IntPtr.Zero; } }

    [DllImport("Mmdevapi.dll", ExactSpelling = true)]
    static extern int ActivateAudioInterfaceAsync([MarshalAs(UnmanagedType.LPWStr)] string path, ref Guid riid, IntPtr activationParams,
        IActivateAudioInterfaceCompletionHandler handler, out IActivateAudioInterfaceAsyncOperation operation);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
    [DllImport("user32.dll")] static extern bool IsWindow(IntPtr hwnd);

    static readonly Guid IID_AudioClient = new Guid("1cb9ad4c-dbfa-4c32-b178-c2f568a703b2");
    static readonly Guid IID_CaptureClient = new Guid("c8adbd64-e71e-48a0-a4de-185c395cd317");

    const uint STREAMFLAGS = 0x00020000 /* LOOPBACK */ | 0x00040000 /* EVENTCALLBACK */ | 0x80000000 /* AUTOCONVERTPCM */ | 0x08000000 /* SRC_DEFAULT_QUALITY */;
    const uint BUFFERFLAGS_SILENT = 0x2;
    public const int RATE = 48000, CHANNELS = 2;

    static volatile bool quit;

    static void Log(string kind, string detail)
    {
        Console.Error.WriteLine("{\"kind\":\"" + kind + "\",\"detail\":" + detail + "}");
        Console.Error.Flush();
    }

    // Captures the audio of the process that owns hwnd (and its child processes) until stdin closes.
    public static void Run(long hwndValue)
    {
        IntPtr hwnd = new IntPtr(hwndValue);
        if (!IsWindow(hwnd)) throw new Exception("window " + hwndValue + " no longer exists");
        uint pid;
        GetWindowThreadProcessId(hwnd, out pid);
        if (pid == 0) throw new Exception("couldn't find the window's process");

        var stdinWatch = new Thread(delegate () { try { Console.OpenStandardInput().CopyTo(Stream.Null); } catch { } quit = true; });
        stdinWatch.IsBackground = true; stdinWatch.Start();

        // WASAPI activation must not run on PowerShell's STA thread.
        Exception error = null;
        var worker = new Thread(delegate () { try { Capture(pid); } catch (Exception e) { error = e; } });
        worker.SetApartmentState(ApartmentState.MTA);
        worker.Start();
        worker.Join();
        if (error != null) throw error;
    }

    static void Capture(uint pid)
    {
        // AUDIOCLIENT_ACTIVATION_PARAMS { PROCESS_LOOPBACK, { pid, INCLUDE_TARGET_PROCESS_TREE } }
        IntPtr ap = Marshal.AllocHGlobal(12);
        Marshal.WriteInt32(ap, 0, 1); Marshal.WriteInt32(ap, 4, (int)pid); Marshal.WriteInt32(ap, 8, 0);
        // PROPVARIANT { vt = VT_BLOB, blob = { cbSize, pBlobData } }
        IntPtr pv = Marshal.AllocHGlobal(24);
        for (int i = 0; i < 24; i += 4) Marshal.WriteInt32(pv, i, 0);
        Marshal.WriteInt16(pv, 0, 65);
        Marshal.WriteInt32(pv, 8, 12);
        Marshal.WriteIntPtr(pv, 8 + IntPtr.Size, ap);

        // WAVEFORMATEX: IEEE float, 2 ch, 48 kHz, 32-bit
        IntPtr fmt = Marshal.AllocHGlobal(18);
        Marshal.WriteInt16(fmt, 0, 3); Marshal.WriteInt16(fmt, 2, CHANNELS); Marshal.WriteInt32(fmt, 4, RATE);
        Marshal.WriteInt32(fmt, 8, RATE * CHANNELS * 4); Marshal.WriteInt16(fmt, 12, CHANNELS * 4);
        Marshal.WriteInt16(fmt, 14, 32); Marshal.WriteInt16(fmt, 16, 0);

        IntPtr client = IntPtr.Zero, capture = IntPtr.Zero;
        var evt = new AutoResetEvent(false);
        try
        {
            var act = new HdrAudioActivation();
            Guid iid = IID_AudioClient;
            IActivateAudioInterfaceAsyncOperation op;
            Check(ActivateAudioInterfaceAsync("VAD\\Process_Loopback", ref iid, pv, act, out op), "ActivateAudioInterfaceAsync");
            if (!act.Done.WaitOne(5000)) throw new Exception("audio activation timed out");
            Check(act.Result, "process loopback activation");
            client = act.Client;

            Check(Fn<InitializeFn>(client, 3)(client, 0 /* SHARED */, STREAMFLAGS, 2000000 /* 200 ms */, 0, fmt, IntPtr.Zero), "IAudioClient.Initialize");
            Check(Fn<SetEventFn>(client, 13)(client, evt.SafeWaitHandle.DangerousGetHandle()), "SetEventHandle");
            Guid cid = IID_CaptureClient;
            Check(Fn<GetServiceFn>(client, 14)(client, ref cid, out capture), "GetService(IAudioCaptureClient)");
            Check(Fn<NoArgFn>(client, 10)(client), "IAudioClient.Start");

            Log("started", "{\"pid\":" + pid + "}");

            var getBuffer = Fn<GetBufferFn>(capture, 3);
            var releaseBuffer = Fn<ReleaseBufferFn>(capture, 4);
            var packetSize = Fn<PacketSizeFn>(capture, 5);
            Stream stdout = Console.OpenStandardOutput();
            uint seq = 0;
            byte[] chunk = new byte[0];

            while (!quit)
            {
                evt.WaitOne(100);
                uint next;
                while (!quit && packetSize(capture, out next) >= 0 && next > 0)
                {
                    IntPtr data; uint frames, flags;
                    Check(getBuffer(capture, out data, out frames, out flags, IntPtr.Zero, IntPtr.Zero), "GetBuffer");
                    int bytes = (int)frames * CHANNELS * 4;
                    if (chunk.Length != 16 + bytes)
                    {
                        chunk = new byte[16 + bytes];
                        Encoding.ASCII.GetBytes("HDRA").CopyTo(chunk, 0);
                    }
                    if ((flags & BUFFERFLAGS_SILENT) != 0 || data == IntPtr.Zero) Array.Clear(chunk, 16, bytes);
                    else Marshal.Copy(data, chunk, 16, bytes);
                    releaseBuffer(capture, frames);

                    BitConverter.GetBytes(frames).CopyTo(chunk, 4);
                    BitConverter.GetBytes(0u).CopyTo(chunk, 8);
                    BitConverter.GetBytes(++seq).CopyTo(chunk, 12);
                    try { stdout.Write(chunk, 0, chunk.Length); stdout.Flush(); }
                    catch { quit = true; }
                }
            }
            Fn<NoArgFn>(client, 11)(client);   // Stop
        }
        finally
        {
            Rel(ref capture); Rel(ref client);
            Marshal.FreeHGlobal(fmt); Marshal.FreeHGlobal(pv); Marshal.FreeHGlobal(ap);
            evt.Close();
        }
    }
}
`;
