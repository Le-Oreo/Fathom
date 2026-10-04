import { isTauri } from "@tauri-apps/api/core";
import type { DeviceApi } from "./api";
import { MockFlipper } from "./mock";
import { TauriFlipper } from "./tauri";

const real = isTauri() && import.meta.env.VITE_FATHOM_MOCK !== "1";
export const mockDevice: MockFlipper | null = real ? null : new MockFlipper();
export const api: DeviceApi = mockDevice ?? new TauriFlipper();
export const usingMock = mockDevice !== null;
