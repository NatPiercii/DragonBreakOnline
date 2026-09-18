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
