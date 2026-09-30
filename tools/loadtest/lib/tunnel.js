// The PC end of the UDP tunnel to a sandbox on CT 115 (ct115/udp-tunnel.js is the other end), for --tunnel.
//
// Same shape as lib/relay.js, so the runner uses it the same way: open(botId) gives the bot a local UDP port, and
// everything the bot sends there goes down its own TCP connection to 127.0.0.1:<tunnelPort>, which `ssh -L` carries
// to CT 115. It counts both directions like the relay, so --tunnel runs report real bytes as well.
'use strict';
const dgram = require('dgram');
const net = require('net');
const { frame, makeDeframer } = require('../ct115/udp-tunnel');

class Tunnel {
  constructor(opts) {
    this.tunnelHost = opts.tunnelHost || '127.0.0.1';
    this.tunnelPort = opts.tunnelPort;
    this.basePort = opts.basePort || 27800;
    this.entries = new Map(); // botId -> { socket, conn, port, botAddr, toServer, toBot, pktToServer, pktToBot }
  }

  async open(botId) {
    const port = this.basePort + botId;
    const socket = dgram.createSocket('udp4');
    const entry = { socket, conn: null, port, botAddr: null, toServer: 0, toBot: 0, pktToServer: 0, pktToBot: 0 };
    this.entries.set(botId, entry);
    entry.conn = await new Promise((resolve, reject) => {
      const c = net.connect(this.tunnelPort, this.tunnelHost, () => resolve(c));
      c.once('error', (e) => reject(new Error('tunnel ' + this.tunnelHost + ':' + this.tunnelPort + ' refused bot ' + botId +
        ' (is ssh -L ' + this.tunnelPort + ':127.0.0.1:' + this.tunnelPort + ' open, and ct115/sandbox.sh tunnel running?): ' + e.message)));
    });
    entry.conn.setNoDelay(true);
    entry.conn.on('data', makeDeframer((d) => {
      if (!entry.botAddr) return;
      entry.toBot += d.length; entry.pktToBot++;
      socket.send(d, entry.botAddr.port, entry.botAddr.address);
    }));
    entry.conn.on('error', () => { /* the bot sees the silence and times out like on a dead link */ });
    socket.on('message', (msg, rinfo) => {
      entry.botAddr = { port: rinfo.port, address: rinfo.address };
      entry.toServer += msg.length; entry.pktToServer++;
      if (!entry.conn.destroyed) entry.conn.write(frame(msg));
    });
    await new Promise((resolve, reject) => { socket.once('error', reject); socket.bind(port, '127.0.0.1', resolve); });
    return port;
  }

  totals() {
    const t = { toServer: 0, toBot: 0, pktToServer: 0, pktToBot: 0, bots: this.entries.size };
    for (const e of this.entries.values()) { t.toServer += e.toServer; t.toBot += e.toBot; t.pktToServer += e.pktToServer; t.pktToBot += e.pktToBot; }
    return t;
  }

  close() {
    for (const e of this.entries.values()) {
      try { e.socket.close(); } catch (err) { /* closed */ }
      try { e.conn.destroy(); } catch (err) { /* closed */ }
    }
    this.entries.clear();
  }
}

module.exports = { Tunnel };
