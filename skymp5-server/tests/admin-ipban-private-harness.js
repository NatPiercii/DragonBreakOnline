// The in-game IP ban refuses internal addresses (adminSystem.ts isPrivateAddress): on 6 Oct every player showed as
// 10.10.10.1, the host's forward, so an IP ban would have banned the whole server.
//   node tests/admin-ipban-private-harness.js
'use strict';
const fs = require('fs'); const path = require('path');
const src = fs.readFileSync(path.join(__dirname, '..', 'ts', 'systems', 'adminSystem.ts'), 'utf8');
const m = /export const isPrivateAddress = \(ip: string\): boolean => \{([\s\S]*?)\n\};/.exec(src);
if (!m) { console.log('FAIL isPrivateAddress not found'); process.exit(1); }
const isPrivateAddress = new Function('ip', m[1]);
let fail = 0; const ok = (c, w) => { console.log(`${c ? 'ok  ' : 'FAIL'} ${w}`); if (!c) fail++; };
for (const ip of ['10.10.10.1', '127.0.0.1', '192.168.12.100', '172.16.0.5', '172.31.255.1', '169.254.1.1', '::1', 'fd00::1', '::ffff:10.10.10.1', '']) ok(isPrivateAddress(ip) === true, `${ip || '(empty)'} is internal`);
for (const ip of ['50.116.28.194', '8.8.8.8', '172.32.0.1', '11.0.0.1', '2001:db8::1']) ok(isPrivateAddress(ip) === false, `${ip} is a real address`);
ok(/action === "ipBan" && isPrivateAddress\(ip\)/.test(src) && /IP bans are off/.test(src), 'the ipBan action refuses an internal address with a message');
console.log(fail ? `${fail} failed` : 'all passed'); process.exit(fail ? 1 : 0);
