import type { FlipperClock } from "./device/api";

export const clockOf = (d: Date): FlipperClock => ({
  year: d.getFullYear(),
  month: d.getMonth() + 1,
  day: d.getDate(),
  hour: d.getHours(),
  minute: d.getMinutes(),
  second: d.getSeconds(),
  weekday: d.getDay() || 7,
});

export const dateOf = (c: FlipperClock) => new Date(c.year, c.month - 1, c.day, c.hour, c.minute, c.second);

/* "3 min 12 s behind", "just right" */
export function driftText(ms: number) {
  const s = Math.round(Math.abs(ms) / 1000);
  if (s < 2) return "right on time";
  const parts =
    s >= 86400
      ? `${Math.round(s / 86400)} days`
      : s >= 3600
        ? `${Math.floor(s / 3600)} h ${Math.round((s % 3600) / 60)} min`
        : s >= 60
          ? `${Math.floor(s / 60)} min ${s % 60} s`
          : `${s} s`;
  return `${parts} ${ms < 0 ? "behind" : "ahead"}`;
}
