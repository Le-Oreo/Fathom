import { useEffect, useRef } from "react";
import { Buddy, paintStill, type BuddyOptions } from "./Buddy";

type Props = { opts: BuddyOptions; onBuddy?: (b: Buddy) => void } & React.HTMLAttributes<HTMLDivElement>;

export function BuddyHost({ opts, onBuddy, ...rest }: Props) {
  const host = useRef<HTMLDivElement>(null);
  const first = useRef({ opts, onBuddy });
  useEffect(() => {
    if (!host.current) return;
    const b = new Buddy(host.current, first.current.opts);
    first.current.onBuddy?.(b);
    return () => b.destroy();
  }, []);
  return <div ref={host} {...rest} className={`${rest.className ?? ""} buddy`.trim()} />;
}

export function BuddyStill({ name = "base", px = 1 }: { name?: string; px?: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => (ref.current ? paintStill(ref.current, name, px) : undefined), [name, px]);
  return <canvas ref={ref} className="buddy-still" aria-hidden="true" />;
}
