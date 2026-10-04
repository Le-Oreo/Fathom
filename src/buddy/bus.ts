export type BuddyEvent =
  | "hello"
  | "connected"
  | "screenshot"
  | "uploaded"
  | "downloaded"
  | "firmware"
  | "saved"
  | "backup"
  | "restored"
  | "find"
  | "scan"
  | "rpc"
  | "command";

export interface Reactor {
  visible(): boolean;
  react(kind: BuddyEvent): void;
}
export const reactors = new Set<Reactor>();

export function buddyReact(kind: BuddyEvent) {
  reactors.forEach((b) => {
    if (b.visible()) b.react(kind);
  });
}
