// Whether voice activation may run, given the echo cancellation the playback has. No browser calls, so a harness can load it.
// A player on speakers whose playback is not echo-cancelled sends everyone's voices back through an open mic (Double Voice,
// #bugs 1555114080350507049, 1 Oct). Echo states, set by VoiceManager:
//   none      no voice is playing yet: nothing to send back
//   elements  the mix could not be built, so each voice plays from its own WebRTC element, which Chromium cancels
//   pending   the echo loop is connecting
//   on        the echo loop carries the mix: cancelled
//   off | failed  the mix plays straight from WebAudio: not cancelled
const CANCELLED = new Set(['none', 'elements', 'on']);

// The activation in force: the player's choice, except 'vad' needs cancelled playback
export const effectiveActivation = (chosen, echo) => (chosen === 'vad' && !CANCELLED.has(echo) ? 'ptt' : chosen === 'vad' ? 'vad' : 'ptt');

// True when the player should be told, once, that voice activation is off for now (not while the loop is still connecting)
export const vadBlocked = (chosen, echo) => chosen === 'vad' && (echo === 'off' || echo === 'failed');

export const BLOCKED_NOTICE = 'push-to-talk only for now. Echo cancellation is not working here. Please use headphones: on speakers, others hear their own voices come back while you talk.';

export default effectiveActivation;
