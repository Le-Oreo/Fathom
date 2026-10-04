# Building from source

FATHOM is built with **[Tauri 2](https://tauri.app)** (Rust) and **React + TypeScript**.

## What you need

- [Rust](https://rustup.rs)
- [Node.js](https://nodejs.org) 22 or newer
- The [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/) for your system (on Linux also `libudev-dev` and `libdbus-1-dev`)

## Build it

```sh
git clone --recurse-submodules https://github.com/Le-Oreo/fathom.git
cd fathom
npm ci
npm run tauri dev        # run it
npm run tauri build      # make an installer for this computer
```

Forgot `--recurse-submodules`? Run `git submodule update --init`. FATHOM needs Flipper's protobuf definitions in `src-tauri/proto`.

## Try the interface without a Flipper

```sh
npm run dev
```

This opens FATHOM's interface in your browser with a pretend Flipper, so you can click around with no hardware.

## How it fits together

```
React UI (src/)                       Rust core (src-tauri/)
  views/  components/  state/           transport/  USB serial and Bluetooth
  device/api.ts  <- the only way in     rpc/        protobuf RPC: framing and replies
     mock.ts  (pretend Flipper)         services/   device, screen, storage, library, apps,
     tauri.ts (the real one)  --invoke-->           firmware, backup, sync
```

FATHOM talks to the Flipper with its protobuf RPC over USB serial or Bluetooth, the same protocol qFlipper uses. The interface never touches the device directly. Everything goes through `src/device/api.ts`, which has the real implementation and a pretend one that behave the same.

## Making a release

1. Bump the version in `package.json`, `src-tauri/Cargo.toml` and `src-tauri/tauri.conf.json`, and push.
2. Go to **Actions → FATHOM installers → Run workflow** and type the version.
3. A draft release appears with installers for every system. Check it and click **Publish**.
