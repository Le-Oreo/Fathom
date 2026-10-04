# Installation

Download the installer for your computer from the **[Releases page](https://github.com/Le-Oreo/Fathom/releases)**. Open the newest release and pick your file under **Assets**:

| Your computer | File to download |
| --- | --- |
| **Windows** 10 or 11 | `FATHOM_x.y.z_x64-setup.exe` |
| **Mac** with Apple Silicon (M1, M2, M3, M4…) | `FATHOM_x.y.z_aarch64.dmg` |
| **Mac** with an Intel chip | `FATHOM_x.y.z_x64.dmg` |
| **Linux** (Ubuntu, Debian, Mint…) | `.deb` |
| **Linux** (Fedora, openSUSE…) | `.rpm` |
| **Linux** (anything else) | `.AppImage` |

> [!TIP]
> Not sure which Mac you have? Click the Apple menu → **About This Mac**. If it says *Chip: Apple M…*, use the Apple Silicon file. If it says *Processor: Intel*, use the Intel one.

## Windows

1. Run `FATHOM_x.y.z_x64-setup.exe`.
2. Windows shows a blue **"Windows protected your PC"** box. Click **More info**, then **Run anyway**.
3. Click through the installer. FATHOM appears in the Start menu.

## macOS

1. Open the `.dmg` and drag **FATHOM** into **Applications**.
2. The first time, **right-click** FATHOM in Applications and choose **Open**, then **Open** again. After that it opens normally.
3. If you use Bluetooth, allow FATHOM when macOS asks for Bluetooth access.

## Linux

**`.deb` or `.rpm`:** install it the usual way, for example:

```sh
sudo apt install ./FATHOM_x.y.z_amd64.deb      # Ubuntu, Debian, Mint
sudo dnf install ./FATHOM-x.y.z-1.x86_64.rpm   # Fedora
```

These packages also add a **udev rule**, so FATHOM can open the Flipper's port without root.

**`.AppImage`:** make it executable and run it:

```sh
chmod +x FATHOM_x.y.z_amd64.AppImage
./FATHOM_x.y.z_amd64.AppImage
```

The AppImage can't add the udev rule itself. If FATHOM says it isn't allowed to open the Flipper's port, the Connect page shows the one-time commands to copy, or run them from here:

```sh
echo 'SUBSYSTEMS=="usb", ATTRS{idVendor}=="0483", ATTRS{idProduct}=="5740", ATTRS{manufacturer}=="Flipper Devices Inc.", TAG+="uaccess"' | sudo tee /etc/udev/rules.d/41-fathom-flipper.rules
sudo udevadm control --reload-rules && sudo udevadm trigger
```

Then unplug the Flipper and plug it back in.

## Why does my computer warn me?

FATHOM isn't **code-signed** yet. Signing certificates cost money every year, and FATHOM is a free project. The warning only means Windows or macOS doesn't recognise the publisher. The code is all public on GitHub and the installers are built by GitHub Actions straight from it.

## Updating FATHOM

When a newer version is out, FATHOM shows a **yellow banner** at the top of the window. Click **Download**, install it over the old one, and your settings, backups and library stay as they were.

## Before you connect

> [!IMPORTANT]
> **Quit qFlipper and close Flipper Lab** before using FATHOM. Only one app can use the Flipper's USB port at a time.

Next: **[Getting started →](Getting-Started)**
