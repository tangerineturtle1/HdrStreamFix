# Changelog

## 1.0.1

- Fixed blurry, pixelated streams. The HDR stream is now marked as screen content, so Discord keeps full resolution. Before, it was handled like a webcam and dropped to 640×360 under normal bandwidth.

## 1.0.0

- **HDR screen and window sharing.** Captures the real HDR image and tone-maps it on the GPU, so viewers don't get a washed-out or blown-out picture. Windows HDR stays on.
- **Window Audio Only.** Window shares send only that app's audio, so people in the call don't hear themselves. This works even with Voicemeeter, Sonar or a second Discord open.
- **Fast output.** Frames go to Discord as NV12 (the encoder's native format), produced on the GPU. That's 2.7× less data per frame than RGB.
- **HDR for Videos.** If Windows HDR is off, it turns on while an HDR video plays in chat.
- **Simple settings,** using the resolution and frame rate you choose in Vesktop's share dialog.
- **Installer** (install.bat), plus a self-test that checks HDR capture and app-only audio before you stream.
