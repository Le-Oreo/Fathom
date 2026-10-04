# Troubleshooting

## FATHOM doesn't find my Flipper

- Make sure the Flipper is **on and unlocked**.
- Try **another USB-C cable**. Lots of cables only carry power, not data.
- Plug straight into the computer rather than a hub.
- **Quit qFlipper** and close **Flipper Lab**: only one app can use the port.

## "Another app is using the Flipper"

qFlipper, Flipper Lab, a serial terminal or another copy of FATHOM has the port open. Close it and FATHOM connects on its own.

## "Fathom isn't allowed to open the Flipper's port" (Linux)

Add the udev rule. The Connect page shows the commands to copy, and they're also on the **[Installation](Installation#linux)** page. Then unplug the Flipper and plug it back in.

## "The Flipper doesn't answer"

Unlock the Flipper and close any app that's open on it. If it still doesn't answer, unplug it, plug it back in, or restart it (hold **Left** + **Back**).

## Bluetooth won't connect

- Pair the Flipper in your **computer's** Bluetooth settings first. The Flipper shows a PIN.
- Check *Settings → Connection → Use Bluetooth when unplugged* is on.
- If it paired before but stopped working, remove the Flipper from your computer's Bluetooth list and pair again.

## A firmware update stopped partway

- **If the Flipper's screen shows update progress**, leave it plugged in. It's working, and FATHOM reconnects when it's done.
- If FATHOM says the install stopped and the Flipper is on its normal home screen, nothing important changed. Press **Retry**.
- If the Flipper shows an error on its own screen, install again from the Firmware page.

## An app won't start after a firmware update

Apps installed on the SD card are built for a particular firmware. Get the version of that app made for your new firmware.

## Getting help

Go to **Settings → About → Copy diagnostics** and paste it into a **[new issue](https://github.com/Le-Oreo/Fathom/issues)** along with what happened. It includes FATHOM's version, how the Flipper is connected and recent log lines. It never includes your files or your Flipper's identifiers.
