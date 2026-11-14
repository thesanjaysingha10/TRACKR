# TRACKR

A free motion tracker for **Adobe Premiere Pro**. TRACKR follows a subject in your clip and gives you a smooth follow-zoom, and it can make text or graphics stick to that subject, without leaving Premiere for After Effects.

Built by [@thesanjaysingha](https://instagram.com/thesanjaysingha) with Claude.

## What it does

- **Follow zoom:** click the subject, and TRACKR tracks it frame by frame and writes Scale and Position keyframes so the zoomed frame follows it.
- **Attach to subject:** select a text or graphic clip and it moves with the tracked subject, and it keeps up with the follow-zoom too.
- **Controls:** zoom amount, target size, how tightly it follows, ease in and out, "hold in place" or "centre" framing, an optional rule-of-thirds guide, and zoom back out at the end.
- **Runs locally:** the tracker is plain JavaScript inside the panel, and frames are read with a bundled copy of FFmpeg. Nothing is uploaded anywhere.

## Install

Download the installer for your system from the [latest release](../../releases/latest), close Premiere Pro, and run it.

| System | File |
|---|---|
| Mac (Apple Silicon and Intel) | `TRACKR-<version>-mac.pkg` |
| Windows | `TRACKR-<version>-windows-setup.exe` |

You can also open the `.zxp` files with any ZXP installer.

Then open Premiere and go to **Window > Extensions > TRACKR**.

**On a Mac**, macOS will say the installer is from an unidentified developer. Right-click it, choose **Open**, then **Open** again.
**On Windows**, SmartScreen may warn about an unknown publisher. Choose **More info > Run anyway**.

If the panel is missing from the menu or opens blank, turn on Adobe's extension developer mode and restart Premiere:

```bash
# Mac
defaults write com.adobe.CSXS.12 PlayerDebugMode 1
```

```bat
:: Windows
reg add HKCU\Software\Adobe\CSXS.12 /v PlayerDebugMode /t REG_SZ /d 1 /f
```

Use `CSXS.11` instead for Premiere Pro 2024 and earlier.

## How to use it

1. Select a video clip in the timeline and click the refresh button in the panel.
2. Scrub to a frame and click the subject you want to follow.
3. Set **In** and **Out** for where the zoom should run.
4. Press **Track**, then **Apply**. The keyframes are written to the clip.
5. To pin text to the subject: select the text or graphic clip in the timeline, then press **Attach to subject**.

## Build it yourself

The panel source is in `extension/` (a CEP extension: `CSXS/manifest.xml`, `client/` for the panel UI and tracker, `host/` for the Premiere ExtendScript side).

To try it without packaging, symlink `extension/` into `~/Library/Application Support/Adobe/CEP/extensions/com.studio.trackr`, turn on developer mode as shown above, and restart Premiere. In this mode the panel uses an FFmpeg it finds on your system (`brew install ffmpeg`).

To build the signed installers:

1. Put the tools in `build/vendor/` (they are not in this repo):
   - `zxpsign/ZXPSignCmd`, Adobe's signing tool
   - `ffmpeg-darwin-arm64/ffmpeg`, `ffmpeg-darwin-x64/ffmpeg`, `ffmpeg-win32-x64/ffmpeg` from [ffmpeg-static b6.1.1](https://github.com/eugeneware/ffmpeg-static/releases/tag/b6.1.1)
2. Install NSIS: `brew install makensis`
3. Run `build/package.sh`. It makes a self-signed certificate on the first run and writes the installers to `build/dist/`.

## Third-party

The installers include an unmodified copy of FFmpeg, which is licensed under the GNU GPL v3 or later. See [`build/THIRD-PARTY.txt`](build/THIRD-PARTY.txt).
