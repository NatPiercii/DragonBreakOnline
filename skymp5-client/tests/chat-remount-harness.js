// Chat after an in-game auto-reconnect: AuthService wipes every widget on CreateActor(isMe) and ChatService mounts again on the same page.
// Run from skymp5-client: node tests/chat-remount-harness.js
'use strict';
const fs = require('fs');

const src = fs.readFileSync(process.argv[2] || require('path').resolve(__dirname, '..', 'src', 'services', 'services', 'chatService.ts'), 'utf8');
const start = src.indexOf('const buildMountJs = (');
const end = src.indexOf('})();`;', start);
if (start < 0 || end < 0) { console.log('FAIL could not find buildMountJs'); process.exit(2); }
let fnSrc = src.slice(start, end + '})();`;'.length)
  .replace('const buildMountJs = (name: string, isAdmin: boolean, settingsJson: string, chatHidden: boolean) =>',
           'return (name, isAdmin, settingsJson, chatHidden) =>');
const buildMountJs = new Function(fnSrc)();

// A minimal page: the widget list the front renders, and the bits of DOM the mount script touches
let widgets = [];
const head = { appendChild() {} };
const window = {
  skyrimPlatform: { widgets: { get: () => widgets, set: (w) => { widgets = w; } }, sendMessage() {} },
};
const document = { getElementById: () => null, createElement: () => ({}), head };
const runInPage = (js) => new Function('window', 'document', js)(window, document);

let failures = 0;
const check = (name, ok, got) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${got !== undefined ? '   ' + JSON.stringify(got) : ''}`); if (!ok) failures++; };
const chatCount = () => widgets.filter((w) => w && w.type === 'chat').length;

// 1. first login
runInPage(buildMountJs('Nehrem', false, '{}', false));
check('first login: the chat widget is mounted', chatCount() === 1, widgets.map((w) => w.type));

// a message arrives, so we can tell the history survives
window.__alduinakAddChat('[[S]]hello', -1);
const before = window.chatMessages.length;

// other in-game widgets the session had
widgets = widgets.concat([{ type: 'hud', id: 29 }]);

// 2. reconnect: AuthService.onCreateActorMessage (isMe) wipes every widget
runInPage('window.skyrimPlatform.widgets.set([]);');
check('after the reconnect wipe the chat is gone (expected)', chatCount() === 0);

// 3. ChatService remounts on the new owner model
runInPage(buildMountJs('Nehrem', false, '{}', false));
check('after the remount the chat widget is back', chatCount() === 1, widgets.map((w) => w.type));
check('the chat history survived the remount', window.chatMessages.length === before, window.chatMessages.length);

// 4. a remount while the chat is still there must not add a second one
runInPage(buildMountJs('Nehrem', false, '{}', false));
check('a remount with the chat present leaves exactly one chat', chatCount() === 1, widgets.map((w) => w.type));

console.log(failures ? `${failures} failure(s)` : 'all ok');
process.exit(failures ? 1 : 0);
