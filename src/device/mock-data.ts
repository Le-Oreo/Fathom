export interface MockFile {
  name: string;
  dir?: boolean;
  size?: string;
  date: string;
}

export const MOCK_DEVICE = {
  name: "Nautilus",
  model: "Flipper Zero",
  hardware: "F7",
  region: "US",
  firmware: "1.3.4",
  branch: "release",
  latest: "1.4.0",
  target: "f7",
  port: "/dev/cu.usbmodemflip_Nautilus1",
  battery: 86,
  charging: true,
  sdUsed: 7.2,
  sdTotal: 29.7,
  intUsed: 0.2,
  intTotal: 1,
};

/* The newest version on each update channel. */
export const MOCK_RELEASES = { release: "1.4.0", rc: "1.5.0-rc", dev: "1.5.0-dev-placeholder" } as const;
export const mockChangelog = (version: string) =>
  `## ${version}\n\n- Placeholder: a change to the Sub-GHz app\n- Placeholder: a fix for the file browser\n- Placeholder: faster start-up`;

export const MOCK_LIBRARY: Record<string, { meta: string; detail: string; fields: [string, string][] }> = {
  "/ext/subghz/RAW_0042.sub": {
    meta: "433.92 MHz",
    detail: "RAW",
    fields: [
      ["Frequency", "433.92 MHz"],
      ["Preset", "AM650"],
      ["Protocol", "RAW"],
    ],
  },
  "/ext/subghz/garage_left.sub": {
    meta: "315.00 MHz",
    detail: "Princeton",
    fields: [
      ["Frequency", "315.00 MHz"],
      ["Preset", "AM650"],
      ["Protocol", "Princeton"],
    ],
  },
  "/ext/subghz/gate_opener.sub": {
    meta: "433.92 MHz",
    detail: "CAME 12bit",
    fields: [
      ["Frequency", "433.92 MHz"],
      ["Preset", "AM650"],
      ["Protocol", "CAME 12bit"],
    ],
  },
  "/ext/subghz/doorbell.sub": {
    meta: "433.92 MHz",
    detail: "Princeton",
    fields: [
      ["Frequency", "433.92 MHz"],
      ["Preset", "AM650"],
      ["Protocol", "Princeton"],
    ],
  },
  "/ext/subghz/weather_station.sub": {
    meta: "433.92 MHz",
    detail: "RAW",
    fields: [
      ["Frequency", "433.92 MHz"],
      ["Preset", "AM270"],
      ["Protocol", "RAW"],
    ],
  },
  "/ext/subghz/ceiling_fan.sub": {
    meta: "303.87 MHz",
    detail: "RAW",
    fields: [
      ["Frequency", "303.87 MHz"],
      ["Preset", "AM650"],
      ["Protocol", "RAW"],
    ],
  },
  "/ext/infrared/living_room_tv.ir": {
    meta: "6 buttons",
    detail: "Samsung32",
    fields: [
      ["Buttons", "6"],
      ["Protocol", "Samsung32"],
    ],
  },
  "/ext/infrared/air_conditioner.ir": {
    meta: "4 buttons",
    detail: "RAW",
    fields: [
      ["Buttons", "4"],
      ["Protocol", "RAW"],
    ],
  },
  "/ext/infrared/projector.ir": {
    meta: "3 buttons",
    detail: "NEC",
    fields: [
      ["Buttons", "3"],
      ["Protocol", "NEC"],
    ],
  },
  "/ext/nfc/desk_tag.nfc": { meta: "NTAG215", detail: "NFC-A", fields: [["Type", "NTAG215"]] },
  "/ext/nfc/gym_card.nfc": { meta: "Mifare Classic 1K", detail: "NFC-A", fields: [["Type", "Mifare Classic 1K"]] },
  "/ext/lfrfid/office_fob.rfid": { meta: "EM4100", detail: "125 kHz", fields: [["Type", "EM4100"]] },
  "/ext/badusb/hello_world.txt": {
    meta: "DuckyScript",
    detail: "12 lines",
    fields: [
      ["Lines", "12"],
      ["Keyboard", "US"],
    ],
  },
  "/ext/badusb/open_notes.txt": {
    meta: "DuckyScript",
    detail: "5 lines",
    fields: [
      ["Lines", "5"],
      ["Keyboard", "US"],
    ],
  },
  "/ext/ibutton/building_key.ibtn": { meta: "Dallas DS1990", detail: "8 bytes", fields: [["Type", "Dallas DS1990"]] },
};

export const MOCK_FILES: Record<string, MockFile[]> = {
  "/ext": [
    { name: "apps", dir: true, date: "Sep 12" },
    { name: "apps_data", dir: true, date: "Sep 30" },
    { name: "badusb", dir: true, date: "Jul 30" },
    { name: "ibutton", dir: true, date: "Jun 21" },
    { name: "infrared", dir: true, date: "Sep 30" },
    { name: "lfrfid", dir: true, date: "Aug 19" },
    { name: "music_player", dir: true, date: "Aug 08" },
    { name: "nfc", dir: true, date: "Sep 25" },
    { name: "subghz", dir: true, date: "Today 10:21" },
    { name: "update", dir: true, date: "Sep 01" },
  ],
  "/ext/apps": [
    { name: "Games", dir: true, date: "Sep 12" },
    { name: "Sub-GHz", dir: true, date: "Sep 02" },
    { name: "Tools", dir: true, date: "Sep 12" },
  ],
  "/ext/apps/Games": [
    { name: "2048.fap", size: "7 KB", date: "Aug 21" },
    { name: "flappy_bird.fap", size: "8 KB", date: "Aug 21" },
    { name: "snake_game.fap", size: "9 KB", date: "Sep 12" },
    { name: "tetris_game.fap", size: "11 KB", date: "Sep 12" },
  ],
  "/ext/apps/Sub-GHz": [{ name: "weather_station.fap", size: "21 KB", date: "Sep 02" }],
  "/ext/apps/Tools": [
    { name: "hex_viewer.fap", size: "6 KB", date: "Sep 12" },
    { name: "signal_generator.fap", size: "10 KB", date: "Sep 02" },
    { name: "spectrum_analyzer.fap", size: "14 KB", date: "Sep 12" },
  ],
  "/ext/apps_data": [
    { name: "hex_viewer", dir: true, date: "Sep 12" },
    { name: "snake_game", dir: true, date: "Sep 30" },
  ],
  "/ext/apps_data/hex_viewer": [],
  "/ext/apps_data/snake_game": [{ name: "highscore.save", size: "1 KB", date: "Sep 30" }],
  "/ext/badusb": [
    { name: "hello_world.txt", size: "1 KB", date: "Jul 30" },
    { name: "open_notes.txt", size: "1 KB", date: "Jul 12" },
  ],
  "/ext/ibutton": [{ name: "building_key.ibtn", size: "1 KB", date: "Jun 21" }],
  "/ext/infrared": [
    { name: "assets", dir: true, date: "Sep 01" },
    { name: "air_conditioner.ir", size: "3 KB", date: "Sep 14" },
    { name: "living_room_tv.ir", size: "1 KB", date: "Sep 30" },
    { name: "projector.ir", size: "1 KB", date: "Aug 02" },
  ],
  "/ext/infrared/assets": [
    { name: "ac.ir", size: "38 KB", date: "Sep 01" },
    { name: "audio.ir", size: "41 KB", date: "Sep 01" },
    { name: "tv.ir", size: "92 KB", date: "Sep 01" },
  ],
  "/ext/lfrfid": [{ name: "office_fob.rfid", size: "1 KB", date: "Aug 19" }],
  "/ext/music_player": [
    { name: "melodies", dir: true, date: "Aug 08" },
    { name: "ode_to_joy.fmf", size: "1 KB", date: "Aug 08" },
  ],
  "/ext/music_player/melodies": [
    { name: "lullaby.fmf", size: "1 KB", date: "Aug 08" },
    { name: "scale_practice.fmf", size: "1 KB", date: "Aug 02" },
  ],
  "/ext/nfc": [
    { name: "desk_tag.nfc", size: "2 KB", date: "Sep 25" },
    { name: "gym_card.nfc", size: "4 KB", date: "Sep 03" },
  ],
  "/ext/subghz": [
    { name: "backups", dir: true, date: "Sep 20" },
    { name: "RAW_0042.sub", size: "12 KB", date: "Today 10:21" },
    { name: "garage_left.sub", size: "1 KB", date: "Sep 28" },
    { name: "gate_opener.sub", size: "1 KB", date: "Sep 22" },
    { name: "doorbell.sub", size: "1 KB", date: "Sep 19" },
    { name: "weather_station.sub", size: "18 KB", date: "Sep 11" },
    { name: "ceiling_fan.sub", size: "2 KB", date: "Aug 30" },
  ],
  "/ext/subghz/backups": [
    { name: "2026-08", dir: true, date: "Aug 31" },
    { name: "doorbell_v1.sub", size: "1 KB", date: "Sep 20" },
    { name: "weather_station_aug.sub", size: "16 KB", date: "Sep 20" },
  ],
  "/ext/subghz/backups/2026-08": [
    { name: "RAW_0019.sub", size: "9 KB", date: "Aug 14" },
    { name: "RAW_0020.sub", size: "14 KB", date: "Aug 22" },
  ],
  "/ext/update": [],
  "/int": [
    { name: ".bt.settings", size: "1 KB", date: "Sep 29" },
    { name: ".desktop.settings", size: "1 KB", date: "Sep 29" },
    { name: ".notification.settings", size: "1 KB", date: "Sep 29" },
  ],
};

/* What the mock's CLI answers. */
export const MOCK_CLI: Record<string, string[]> = {
  free: ["Free heap size: 108432", "Total heap size: 190448", "Minimum heap size: 91376"],
  ps: [
    "Name              State  Prio  Stack",
    "gui               ready  6     1812",
    "desktop           ready  5     1256",
    "rpc_srv           ready  4     1024",
  ],
  log: [
    "Streaming the Flipper's log. Press Ctrl+C to stop.",
    "[I][SubGhz] Frequency 433920000 Hz",
    "[I][Rpc] Session started",
  ],
};

export const MOCK_ACTIVITY = [
  { time: "10:21", icon: "subghz", text: "Saved RAW_0042.sub" },
  { time: "09:58", icon: "upload", text: "Uploaded tv_remote.ir" },
  { time: "09:40", icon: "camera", text: "Took a screenshot" },
  { time: "Sep 29", icon: "archive", text: "Backed up Nautilus" },
] as const;
export const MOCK_TRANSFERS = [
  { name: "tv_remote.ir", to: "/ext/infrared", pct: 64, down: false },
  { name: "garage_left.sub", to: "Downloads", pct: 100, down: true },
];
export const MOCK_BACKUP_DATE = "Sep 29";
