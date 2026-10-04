import { create } from "zustand";
import { usingMock } from "../device";
import { MOCK_ACTIVITY } from "../device/mock-data";
import { dateValue } from "../files/logic";
import type { IconName } from "../icon-map";

export interface Activity {
  time: number;
  icon: IconName;
  text: string;
}

const seed = (): Activity[] =>
  MOCK_ACTIVITY.map((a) => ({
    time: dateValue(/:/.test(a.time) ? `Today ${a.time}` : a.time),
    icon: a.icon,
    text: a.text,
  }));

export const useActivity = create<{ items: Activity[] }>(() => ({ items: usingMock ? seed() : [] }));

export function logActivity(icon: IconName, text: string) {
  useActivity.setState((s) => ({ items: [{ time: Date.now(), icon, text }, ...s.items].slice(0, 5) }));
}
