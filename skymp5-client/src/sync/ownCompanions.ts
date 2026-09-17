// Remote ids of the companions this client owns, published by CompanionService
// Kept apart from it so the world cleaner can ask without importing the service back

import { storage } from "skyrimPlatform";

export const COMPANION_IDS_KEY = "ownCompanionIds";

export const isOwnCompanion = (remoteId: number | undefined): boolean => {
  const ids = storage[COMPANION_IDS_KEY];
  return remoteId !== undefined && Array.isArray(ids) && ids.includes(remoteId);
};
