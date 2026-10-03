// The property menu's Rooms and chests (skymp5-front housing widget; client housingService.ts; server housingSystem.ts
// placeMenu; Nate's N3, 3 Oct): renders the real widget with React's static renderer for the payloads the server sends a
// place's owner, a person a room is assigned to, and a property with no place; and checks the client copies the place
// fields through all three hops (packet -> info -> the browser-side widget object). run-all bundles the widget from $FORK:
//   node tests/housing-rooms-front-harness.js <bundle of skymp5-front/src/features/housing/index.tsx>
'use strict';
const fs = require('fs');
const path = require('path');
const bundle = process.argv[2];
if (!bundle) { console.log('usage: node tests/housing-rooms-front-harness.js <bundle>'); process.exit(2); }
if (!/housing__roomlist/.test(fs.readFileSync(bundle, 'utf8'))) {
  require('./expect')('housing-rooms-front', 'this front has no Rooms and chests');
  console.log('ok   skipped: this front predates Rooms and chests');
  process.exit(0);
}
const { Widget: Housing, roomState, renderToStaticMarkup, createElement } = require(path.resolve(bundle));
let failures = 0;
const check = (label, ok, got) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${!ok && got !== undefined ? '   ' + JSON.stringify(got).slice(0, 500) : ''}`); if (!ok) failures++; };
const render = (data) => renderToStaticMarkup(createElement(Housing, { data }));
const text = (html) => html.replace(/<[^>]+>/g, ' ').replace(/&#x27;|&apos;/g, "'").replace(/&amp;/g, '&').replace(/\s+/g, ' ');
const EV = { claim: 'housing:claim', abandon: 'housing:abandon', revoke: 'housing:revoke', lock: 'housing:lock', unlock: 'housing:unlock', transfer: 'housing:transfer', rename: 'housing:rename', createKey: 'housing:createkey', revokeKeys: 'housing:revokekeys', grantContainer: 'housing:grantcontainer', assign: 'housing:assign', unassign: 'housing:unassign', share: 'housing:share', unshare: 'housing:unshare', cancel: 'housing:cancel' };
const menu = (over) => Object.assign({ targetLabel: 'Door', view: 'owner', owned: true, name: 'Valerio Residence', locked: true, hasKeys: true, canGrantContainers: false, ownerName: 'Augustine Valerio', events: EV }, over);
const rooms = [
  { ref: 0x0800010a, label: 'Strongbox', kind: 'chest', assigned: null, shared: false, other: null },
  { ref: 0x08000106, label: 'Bedroom Door', kind: 'door', assigned: 'Tavia', shared: false, other: null },
  { ref: 0x0800010b, label: 'Strongbox 2', kind: 'chest', assigned: null, shared: true, other: null },
  { ref: 0x0800010c, label: 'Wardrobe', kind: 'chest', assigned: null, shared: false, other: 'Relsth' },
];
let h = render(menu({ place: { root: 0x08000100, name: 'Valerio Residence', here: 0x0800010a, rooms, more: 3 } }));
let t = text(h);
check("the owner's menu has Rooms and chests with every room", /Rooms and chests/.test(t) && /Strongbox Yours alone/.test(t) && /Bedroom Door Assigned to Tavia/.test(t) && /Strongbox 2 Shared with key holders/.test(t) && /Wardrobe Relsth's own/.test(t), t);
check('...the room aimed at is marked', /housing__room housing__room--here[^>]*>\s*<span class="housing__roomname">Strongbox</.test(h), h.slice(0, 400));
check('...a free chest offers Assign and Share; an assigned door Reassign and Take back; a shared chest Keep to myself; another\'s own nothing',
  /Strongbox Yours alone Assign Share/.test(t) && /Bedroom Door Assigned to Tavia Reassign Take back/.test(t) && /Strongbox 2 Shared with key holders Assign Keep to myself/.test(t) && /Wardrobe Relsth's own( And|$)/.test(t), t);
check('...and says how many more there are', /And 3 more, not listed/.test(t), t);
check('...the property buttons are still there (lock, keys, rename)', /Unlock/.test(t) && /Cut a key/.test(t) && /name this property/.test(h));
t = text(render(menu({ place: { root: 1, name: 'X', here: 0, rooms: [], more: 0 } })));
check('a place with no inner doors or chests says so', /No inner doors or chests here/.test(t), t);
t = text(render(menu({ view: 'denied', name: 'Valerio Residence', place: null, placeName: 'Valerio Residence', assignedToYou: true, ownerName: 'Augustine Valerio' })));
check('a person aiming at a room assigned to them is told so, with no rooms panel', /Assigned to you in Valerio Residence\./.test(t) && !/Rooms and chests/.test(t), t);
t = text(render(menu({})));
check('a property with no place: the menu as before', !/Rooms and chests/.test(t) && !/Assigned to you/.test(t) && /Valerio Residence/.test(t), t);
check('roomState for a door nobody holds', roomState({ kind: 'door', assigned: null, shared: false, other: null }) === 'Open to all inside');
// The client's three hops
const fork = process.env.FORK || path.resolve(__dirname, '..', '..', 'fork');
const svcPath = path.join(fork, 'skymp5-client/src/services/services/housingService.ts');
if (fs.existsSync(svcPath)) {
  const svc = fs.readFileSync(svcPath, 'utf8');
  const setter = svc.slice(svc.indexOf('private browsersideWidgetSetter'));
  check('client: the packet\'s place fields are read into info', /place: readPlace\(content\["place"\]\)/.test(svc) && /placeName:/.test(svc) && /assignedToYou: content\["assignedToYou"\] === true/.test(svc));
  check('client: the browser-side widget carries them (no spread there)', /place: info\.place/.test(setter) && /placeName: info\.placeName/.test(setter) && /assignedToYou: info\.assignedToYou/.test(setter) && !/\.\.\./.test(setter.slice(0, setter.indexOf('};'))));
  check('client: assign picks a person, then sends the room with the recipient', /ref: pending\.ref/.test(svc) && /case events\.assign:/.test(svc) && /action: key === events\.transfer \? "transfer" : "grantcontainer",\s*target,\s*ref: 0/.test(svc));
}
console.log(failures ? `\n${failures} FAILED` : '\nall passed');
process.exit(failures ? 1 : 0);
