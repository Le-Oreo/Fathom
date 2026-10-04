import { ICONS, type IconName } from "../icon-map";

export function Icon({ name, size = 18 }: { name: IconName; size?: number }) {
  const Glyph = ICONS[name];
  return <Glyph className="i" size={size} strokeWidth={1.8} aria-hidden="true" />;
}
