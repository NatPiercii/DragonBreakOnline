// A counting UDP relay, one socket per bot, so a run can report real wire bytes.
//
// Windows has no per-process network byte counter without ETW (measured: 10 MB of UDP on loopback moves
// Win32_Process.WriteTransferCount by 0), and the deserialized JSON a bot sees is much larger than the
// binary on the wire. Putting a relay in the middle is the pcap-free way to get the true number: the bot
// connects to 127.0.0.1:<relayPort>, the relay forwards to the server from its own socket and counts both
// directions. RakNet does not care, because from the server's side the relay socket is just another client.
//
// It costs an extra hop per packet, so it is opt-in (--measure-bytes) and best used on the smaller steps:
// bytes per client per second is what extrapolates, not the total.
'use strict';
const dgram = require('dgram');

class Relay {
  constructor(opts) {
    this.serverHost = opts.serverHost;
    this.serverPort = opts.serverPort;
    this.basePort = opts.basePort || 27800;
    this.sockets = new Map(); // botId -> { socket, port, toServer, toBot, pktToServer, pktToBot, botAddr }
  }

  // Returns the port this bot should connect to instead of the server's
  async open(botId) {
    const port = this.basePort + botId;
    const socket = dgram.createSocket('udp4');
    const entry = { socket, port, toServer: 0, toBot: 0, pktToServer: 0, pktToBot: 0, botAddr: null };
    this.sockets.set(botId, entry);

    socket.on('message', (msg, rinfo) => {
      const fromServer = rinfo.port === this.serverPort &&
        (rinfo.address === this.serverHost || rinfo.address === '127.0.0.1');
      if (fromServer) {
        if (!entry.botAddr) return;
        entry.toBot += msg.length;
        entry.pktToBot++;
        socket.send(msg, entry.botAddr.port, entry.botAddr.address);
      } else {
        entry.botAddr = { port: rinfo.port, address: rinfo.address };
        entry.toServer += msg.length;
        entry.pktToServer++;
        socket.send(msg, this.serverPort, this.serverHost);
      }
    });

    await new Promise((resolve, reject) => {
      socket.once('error', reject);
      socket.bind(port, '127.0.0.1', resolve);
    });
    return port;
  }

  totals() {
    let toServer = 0;
    let toBot = 0;
    let pktToServer = 0;
    let pktToBot = 0;
    for (const e of this.sockets.values()) {
      toServer += e.toServer;
      toBot += e.toBot;
      pktToServer += e.pktToServer;
      pktToBot += e.pktToBot;
    }
    return { toServer, toBot, pktToServer, pktToBot, bots: this.sockets.size };
  }

  close() {
    for (const e of this.sockets.values()) { try { e.socket.close(); } catch (err) { /* already closed */ } }
    this.sockets.clear();
  }
}

module.exports = { Relay };
