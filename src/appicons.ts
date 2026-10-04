export interface AppIcon {
  id: string;
  label: string;
  months?: (year: number) => number[];
}

const every =
  (...m: number[]) =>
  () =>
    m;

// prettier-ignore
const LUNAR_NEW_YEAR: Record<number, number> = {
  2026: 2, 2027: 2, 2028: 1, 2029: 2, 2030: 2, 2031: 1, 2032: 2, 2033: 1, 2034: 2, 2035: 2,
  2036: 1, 2037: 2, 2038: 2, 2039: 1, 2040: 2,
};

export function easterMonth(y: number) {
  const a = y % 19,
    b = Math.floor(y / 100),
    c = y % 100,
    d = Math.floor(b / 4),
    e = b % 4,
    f = Math.floor((b + 8) / 25),
    g = Math.floor((b - f + 1) / 3),
    h = (19 * a + b - d - g + 15) % 30,
    i = Math.floor(c / 4),
    k = c % 4,
    l = (32 + 2 * e + 2 * i - h - k) % 7,
    m = Math.floor((a + 11 * h + 22 * l) / 451);
  return Math.floor((h + l - 7 * m + 114) / 31);
}

export const COLOR_ICONS: AppIcon[] = [
  { id: "classic", label: "Classic" },
  { id: "charcoal", label: "Charcoal" },
  { id: "navy", label: "Navy" },
  { id: "teal", label: "Teal" },
  { id: "sky", label: "Sky" },
  { id: "purple", label: "Purple" },
  { id: "cream", label: "Cream" },
];

export const HOLIDAY_ICONS: AppIcon[] = [
  { id: "new-year", label: "New Year", months: every(1) },
  { id: "lunar-new-year", label: "Lunar New Year", months: (y) => (LUNAR_NEW_YEAR[y] ? [LUNAR_NEW_YEAR[y]] : [1, 2]) },
  { id: "valentines", label: "Valentine's Day", months: every(2) },
  { id: "st-patricks", label: "St. Patrick's Day", months: every(3) },
  { id: "easter", label: "Easter", months: (y) => [easterMonth(y)] },
  { id: "4th-of-july", label: "4th of July", months: every(7) },
  { id: "halloween", label: "Halloween", months: every(10) },
  { id: "thanksgiving", label: "Thanksgiving", months: every(11) },
  { id: "hanukkah", label: "Hanukkah", months: every(12) },
  { id: "christmas", label: "Christmas", months: every(12) },
];

export const ALL_ICONS = [...COLOR_ICONS, ...HOLIDAY_ICONS];
export const iconById = (id: string) => ALL_ICONS.find((i) => i.id === id);

/* "2026-10" */
export const monthKey = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;

/* The holiday icons that can be picked this month. */
export const holidaysNow = (d: Date) =>
  HOLIDAY_ICONS.filter((h) => h.months?.(d.getFullYear()).includes(d.getMonth() + 1));

export const holidayPick = (id: string, d: Date) => `${id}@${monthKey(d)}`;

export function isHolidayPick(v: unknown): v is string {
  if (typeof v !== "string") return false;
  const [id, month] = v.split("@");
  return HOLIDAY_ICONS.some((h) => h.id === id) && /^\d{4}-\d{2}$/.test(month ?? "");
}

export function currentIcon(color: string, holiday: string | undefined, d: Date) {
  if (holiday && isHolidayPick(holiday)) {
    const [id, month] = holiday.split("@");
    if (month === monthKey(d)) return id;
  }
  return color;
}

const thumbs = import.meta.glob<string>("./assets/app-icons/*.png", { eager: true, import: "default" });
export const iconThumb = (id: string) => thumbs[`./assets/app-icons/${id}.png`];
