// Remote ids LiveKit last reported as speaking (lipSyncService), read by the nameplates (formView). A report comes every
// 150 ms while anyone talks; one older than a second is stale (voice disconnected), so nobody shows as speaking
const STALE_MS = 1000;
const speaking = new Set<number>();
let reportedAt = 0;

export const setSpeaking = (report: Map<number, number>): void => {
  speaking.clear();
  report.forEach((_level, id) => speaking.add(id));
  reportedAt = Date.now();
};

export const isSpeaking = (remoteId: number): boolean => Date.now() - reportedAt < STALE_MS && speaking.has(remoteId);
