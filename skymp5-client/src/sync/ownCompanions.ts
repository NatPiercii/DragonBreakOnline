import { storage } from "skyrimPlatform";

export const COMPANION_IDS_KEY = "ownCompanionIds";

// Pre-SP3 storage Proxy returns a throwing function for unassigned keys
if (!Array.isArray(storage[COMPANION_IDS_KEY])) {
  storage[COMPANION_IDS_KEY] = [];
}
if (!Array.isArray(storage["allCompanionIds"])) {
  storage["allCompanionIds"] = [];
}

export const isOwnCompanion = (remoteId: number | undefined): boolean => {
  const ids = storage[COMPANION_IDS_KEY];
  return remoteId !== undefined && Array.isArray(ids) && ids.includes(remoteId);
};

export const isAnyCompanion = (remoteId: number | undefined): boolean => {
  if (remoteId === undefined) return false;
  if (isOwnCompanion(remoteId)) return true;
  const all = storage["allCompanionIds"];
  return Array.isArray(all) && all.includes(remoteId);
};

