# TRACKR

**After Effects-style tracking, right inside Premiere Pro.** Free.

Click on a person (or anything) in your clip. TRACKR follows it, and the camera zooms in and moves with it on its own. No After Effects, no keyframing by hand.

Made by [@thesanjaysingha](https://instagram.com/thesanjaysingha) with the help of Claude.

---

## What can it do?

- **Follow zoom:** zooms in on your subject and keeps them in frame as they move.
- **Stick text to someone:** any text or sticker can follow the person around.
- **Smooth and simple:** sliders for how much to zoom, how tightly to follow and how softly it eases in and out.

Everything runs on your own computer. Nothing gets uploaded.

## Download

- **Mac:** [TRACKR-1.0.0-mac.pkg](https://github.com/thesanjaysingha10/TRACKR/releases/download/v1.0.0/TRACKR-1.0.0-mac.pkg) (45 MB)
- **Windows:** [TRACKR-1.0.0-windows-setup.exe](https://github.com/thesanjaysingha10/TRACKR/releases/download/v1.0.0/TRACKR-1.0.0-windows-setup.exe) (30 MB)

Using an extension installer like ZXPInstaller? Get the `.zxp` for [Mac](https://github.com/thesanjaysingha10/TRACKR/releases/download/v1.0.0/TRACKR-1.0.0-mac.zxp) or [Windows](https://github.com/thesanjaysingha10/TRACKR/releases/download/v1.0.0/TRACKR-1.0.0-windows.zxp). All files are also on the [Releases](../../releases/latest) page.

---

## How to install

1. Download the installer for your computer from **Download** above.
2. Close Premiere Pro.
3. Double-click the file you downloaded and follow the steps.
4. Open Premiere and go to **Window > Extensions > TRACKR**.

**Mac says "unidentified developer"?** Right-click the file, click **Open**, then **Open** again.
**Windows shows a blue warning?** Click **More info**, then **Run anyway**.

---

## How to use it

1. Select your video clip in the timeline.
2. Click on the person or thing you want to follow.
3. Set where the zoom should start (**In**) and end (**Out**).
4. Hit **Track**, then **Apply**. Done.

**Want text to follow them?** Track first, then select your text clip and hit **Attach to subject**.

---

## Panel not showing up?

Open **Terminal** (Mac) and paste this, then restart Premiere:

```bash
defaults write com.adobe.CSXS.12 PlayerDebugMode 1
```

On Windows, open **Command Prompt** and paste this instead:

```bat
reg add HKCU\Software\Adobe\CSXS.12 /v PlayerDebugMode /t REG_SZ /d 1 /f
```

(On Premiere Pro 2024 or older, change `12` to `11`.)

---

## For developers

The panel code is in `extension/`, and `build/package.sh` makes the installers. TRACKR uses [FFmpeg](https://ffmpeg.org) to read video frames ([license info](build/THIRD-PARTY.txt)).

If TRACKR saved you a trip to After Effects, follow [@thesanjaysingha](https://instagram.com/thesanjaysingha) for more. ✌️
