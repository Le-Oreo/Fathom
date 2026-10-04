import data from "./assets/lcd-frames.json";

const decode = (b64: string) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));

/* Sample Flipper screens the mock device shows. */
export const SCREENS = {
  menu: data.menu.map(decode),
  app: data.app.map(decode),
  update: decode(data.update),
  names: data.names,
};
