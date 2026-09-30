// The CT 115 end of the load test's UDP tunnel: TCP in (from the PC, through `ssh -L`), UDP out to the sandbox.
//
//   node udp-tunnel.js --listen 7789 --server-port 7787 [--log tunnel.log]
//
// Only the ssh port reaches CT 115 from outside, and RakNet speaks UDP, so without a forwarded UDP port the PC's
// bots cannot reach a sandbox here. Each bot's datagrams travel inside its own TCP connection, framed with a
// 2-byte length (lib/tunnel.js is the PC end); here each connection gets its own UDP socket, so the server sees
// one client per bot, exactly as it would over the internet.
//
// A tunnel over TCP changes what latency and loss mean (a lost segment is resent and holds everything behind
// it), so the harness reports ping and loss from such a run as the tunnel's, not the internet's. What it measures
// faithfully is the server: CPU, memory, tick and event-loop lag, and whether a step's bots all stay connected.
// When the TCP side falls behind, datagrams from the server are dropped here and counted, as UDP would drop them,
// rather than queued into seconds of lag.
'use strict';
const net = require('net');
const dgram = require('dgram');
const fs = require('fs');

const arg = (name, fallback) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : fallback; };
const LISTEN = Number(arg('--listen', 7789));
const SERVER_PORT = Number(arg('--server-port', 7787));
const SERVER_HOST = '127.0.0.1';
const LOG = arg('--log', null);
// Past this much unsent data on a bot's TCP connection, datagrams from the server are dropped
const MAX_BUFFERED = Number(arg('--max-buffered', 1 << 20));

const totals = { connections: 0, open: 0, toServer: 0, toBots: 0, pktToServer: 0, pktToBots: 0, dropped: 0 };
const log = (text) => {
  const line = `[${new Date().toISOString()}] ${text}\n`;
  if (LOG) fs.appendFileSync(LOG, line); else process.stdout.write(line);
};

// Frames: 2-byte big-endian length, then the datagram. Exported for the harness test.
function frame(datagram) {
  const out = Buffer.allocUnsafe(2 + datagram.length);
  out.writeUInt16BE(datagram.length, 0);
  datagram.copy(out, 2);
  return out;
}
// Feeds TCP bytes in; calls onDatagram for every whole frame and keeps the rest for next time
function makeDeframer(onDatagram) {
  let pending = Buffer.alloc(0);
  return (chunk) => {
    pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
    let at = 0;
    while (pending.length - at >= 2) {
      const len = pending.readUInt16BE(at);
      if (pending.length - at - 2 < len) break;
      onDatagram(pending.subarray(at + 2, at + 2 + len));
      at += 2 + len;
    }
    pending = at ? pending.subarray(at) : pending;
  };
}

function serve() {
  const server = net.createServer((conn) => {
    conn.setNoDelay(true);
    totals.connections++; totals.open++;
    const udp = dgram.createSocket('udp4');
    let closed = false;
    const close = () => { if (closed) return; closed = true; totals.open--; try { udp.close(); } catch (e) { /* closed */ } conn.destroy(); };
    udp.on('message', (msg) => {
      if (conn.writableLength > MAX_BUFFERED) { totals.dropped++; return; }
      totals.toBots += msg.length; totals.pktToBots++;
      conn.write(frame(msg));
    });
    udp.on('error', close);
    conn.on('data', makeDeframer((d) => { totals.toServer += d.length; totals.pktToServer++; udp.send(d, SERVER_PORT, SERVER_HOST); }));
    conn.on('close', close);
    conn.on('error', close);
    udp.bind(0, SERVER_HOST);
  });
  // Loopback only: the PC comes in through ssh, never straight to this port
  server.listen(LISTEN, '127.0.0.1', () => log(`udp tunnel: tcp 127.0.0.1:${LISTEN} -> udp ${SERVER_HOST}:${SERVER_PORT}`));
  setInterval(() => log(`udp tunnel: ${totals.open} open (${totals.connections} total), ${totals.pktToServer} datagrams in, ${totals.pktToBots} out, ${(totals.toBots / 1048576).toFixed(1)} MB out, ${totals.dropped} dropped`), 10000).unref();
}

if (require.main === module) serve();
module.exports = { frame, makeDeframer };
