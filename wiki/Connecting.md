# Connecting

## USB-C

Plug the Flipper in with a **data** cable. FATHOM connects on its own (turn this off under *Settings → Connection → Connect automatically*). When the Flipper restarts, after a firmware update for example, FATHOM reconnects by itself.

The connection badge at the top right shows the Flipper's name and how it's connected.

> [!IMPORTANT]
> Only one app can use the Flipper's USB port at a time. Quit **qFlipper** and close **Flipper Lab** first.

## Bluetooth

FATHOM can also talk to your Flipper wirelessly, so you can manage files and watch the screen with no cable.

1. On the Flipper, make sure Bluetooth is on (*Settings → Bluetooth*).
2. **Pair the Flipper in your computer's Bluetooth settings**, the same way you'd pair headphones. The Flipper shows a PIN to confirm.
3. In FATHOM, turn on **Settings → Connection → Use Bluetooth when unplugged**.
4. Unplug the cable. FATHOM finds the paired Flipper and connects.

Good to know:
- Bluetooth is slower than the cable, so big uploads and firmware installs are best done over USB.
- The **[Console](Console)** needs the cable: the Flipper's command line isn't available over Bluetooth.
- If the cable and Bluetooth are both there, FATHOM uses the cable.

## Several Flippers

Got more than one? Plug them all in. Click the connection badge at the top right to switch between them. FATHOM remembers each one by name, and transfers you start always finish on the Flipper you started them on.

## The Flipper's clock

Each time a Flipper connects, FATHOM sets its clock from your computer's, so file dates and logs are right. You can see how far off it was, and set it again, under **Settings → Connection**. Turn off **Set the Flipper's clock** if you'd rather it didn't.
