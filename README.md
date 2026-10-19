# HdrStreamFix

**Version 1.0.1**

A Vencord plugin for **Vesktop on Windows**. It makes screen shares look right when Windows HDR is on.

Normally, if you stream with HDR on, viewers see a washed-out or blown-out, too-bright picture. HdrStreamFix captures your screen or window in HDR and converts it for viewers, so it looks like it does on your monitor. You keep HDR on the whole time.

It also fixes the Vesktop echo problem for window shares. Vesktop normally streams all of your PC's sound, so people in the call can hear themselves. When you share a window, HdrStreamFix sends only that app's audio instead.

## Requirements

- Windows 10 (2004 or newer) or Windows 11
- **Vesktop** (from https://vesktop.dev). Open it once and log in before installing. The regular Discord app isn't supported, because it captures streams in a way plugins can't change.

## Install

1. Download the latest zip from **Releases** and unzip the whole folder.
2. Double-click **install.bat**.

The installer:
1. installs Git, Node.js and pnpm if they're missing,
2. builds Vencord with the plugin,
3. points Vesktop at that build and turns the plugin on,
4. restarts Vesktop.

The first install takes a few minutes. If you already use a custom Vencord build in Vesktop, the plugin is added to that one.

After installing, find it under **Settings → Vencord → Plugins → HdrStreamFix**.

## Settings

| Setting | What it does |
|---|---|
| HDR Stream Fix | Turns the fix on or off |
| Stream Brightness | Auto matches Windows. Pick a higher number if viewers say it's too bright, a lower one if too dark. |
| Highlights | More detail, Balanced or Punchier highlights |
| Brightest Highlight | Auto uses your monitor's peak brightness |
| Window Audio Only | When you share a window with audio, sends only that app's sound. Voice chat, music and other apps are left out, so nobody hears themselves. |
| HDR for Videos | If Windows HDR is off, turns it on while an HDR video plays. Needs Vesktop's Hardware Acceleration. |
| Debug Logging | Logs what the plugin does to the console |

Resolution and frame rate follow what you choose in the share dialog.

## Uninstall

1. Turn **HdrStreamFix** off in Settings → Vencord → Plugins. It stops immediately.
2. To go back to the normal Vencord: in Vesktop, open Settings → Vesktop → **Open Developer Settings**, then click **Reset** under **Vencord Location**. Then restart Vesktop.

## Good to know

- **Don't use Vesktop's "Repair Vencord" or "Force Update Vencord".** They replace your build and the plugin disappears. If that happens, run install.bat again.
- **To update,** unzip the new version and run install.bat again.
- **If something goes wrong,** you get a message and the stream falls back to normal Discord capture, so streaming never breaks.
- **Screen shares (whole monitor)** still send all system audio, as Vesktop normally does. To keep voice chat out, share the game's window instead.
- **Performance:** the conversion runs on your GPU. Frames go to Discord in the same compact video format its encoder uses, so the CPU cost is small (well under 1 ms of GPU time per frame).
- **Viewers still receive SDR.** Discord streams can't carry HDR; this makes the SDR picture look correct.
- **Windows 11** may draw a thin yellow border around a shared window.

## License

GPL-3.0-or-later, the same as Vencord. See LICENSE.
