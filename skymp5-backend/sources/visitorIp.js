'use strict'
const net = require('net')

// Every website user reaches the backend through the same proxy hop; Cloudflare puts the visitor's own address in CF-Connecting-IP
function visitorIp(req) {
  const ip = req.get('cf-connecting-ip')
  return typeof ip === 'string' && net.isIP(ip) ? ip : null
}

module.exports = { visitorIp }
