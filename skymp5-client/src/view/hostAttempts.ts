import { storage } from "skyrimPlatform";

storage["hostAttempts"] = [];

export const tryHost = (targetRemoteId: number): void => {
  const arr = storage["hostAttempts"] as Array<number>;
  if (!arr.includes(targetRemoteId)) {
    arr.push(targetRemoteId);
  }
};

export const nextHostAttempt = (): number | undefined => {
  const arr = storage["hostAttempts"] as Array<number>;
  if (arr.length === 0) {
    return undefined;
  }
  return arr.shift();
};

export const lastTryHost: Record<number, number> = {};

// Remote ids come in two forms: dynamic 0xff ids as they are, plugin-placed actors plus 0x100000000
export const sameRemoteId = (a: number, b: number): boolean => a % 0x100000000 === b % 0x100000000;

// The server hands a destroyed form's id out again, so a queued ask for it would ask for the next NPC instead
export const forgetHostAttempts = (remoteId: number): void => {
  const arr = storage["hostAttempts"];
  if (Array.isArray(arr)) {
    storage["hostAttempts"] = arr.filter((x) => !sameRemoteId(x, remoteId));
  }
  Object.keys(lastTryHost).forEach((key) => {
    if (sameRemoteId(Number(key), remoteId)) delete lastTryHost[Number(key)];
  });
};

export const resetHostAttempts = (): void => {
  storage["hostAttempts"] = [];
  Object.keys(lastTryHost).forEach((key) => delete lastTryHost[Number(key)]);
};
