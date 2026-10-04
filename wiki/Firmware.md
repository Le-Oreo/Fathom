# Firmware

<p align="center"><img src="images/firmware.png" alt="The Firmware page" width="900"></p>

## Updating the official firmware

When a newer official release is out, the Dock shows an **Update** button and the Firmware page says what's new. Click **Install** and FATHOM does everything qFlipper does:

1. **Checks the SD card** has room.
2. **Updates the region data** for your country.
3. **Downloads the update** and checks it isn't damaged.
4. **Copies it to the SD card**, skipping anything already there.
5. **Restarts the Flipper into its updater.**
6. **Waits while the Flipper installs it** and comes back on the new version.

By default FATHOM **backs up the Flipper's settings first**. Untick *Back up settings and keys first* to skip it.

> [!IMPORTANT]
> Keep the cable plugged in until the Flipper is back on its home screen. While it installs, it restarts on its own and its screen shows the progress. That's normal.

## If something goes wrong

- **Before step 5** you can press **Cancel**, and nothing on the Flipper changes.
- If the cable comes out during steps 1–4, nothing that matters was changed. Plug it back in and press **Retry**. It carries on from the files already copied.
- If the cable comes out during the install itself, plug it back in and let the Flipper finish what's on its screen.

## Release channels

Choose what to install under **Update channel**:

| Channel | What it is |
| --- | --- |
| **Release** | The official stable firmware. Best for most people. |
| **Release candidate** | The next release, being tested. |
| **Development** | The newest official builds. Can be unstable. |
| **Momentum** | Popular community firmware, from its makers' GitHub releases. |
| **Unleashed** | Popular community firmware, from its makers' GitHub releases. |
| **Custom package** | An update `.tgz` file from your computer. Only install packages you trust. |

## Community firmware

FATHOM can install **Momentum**, **Unleashed** and other firmware published as GitHub releases, straight from their makers. It uses the release's own update package and checks it against the checksum GitHub lists.

If your Flipper is already on community firmware, the Firmware page says which one and tells you when its makers have a newer release, with an **Install** button. Switching between official and community firmware is fine too. FATHOM tells you what you're replacing before it starts.

## Backups

The **Backups** list is on this page too. See **[Backups](Backups)**.
