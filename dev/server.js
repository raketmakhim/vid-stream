// Local preview:  node dev/server.js  ->  http://localhost:8080
// Serves the page and ./videos, accepts ANY password, and relays sync messages between tabs
// the same way the sync Lambda does. No dependencies. Not part of the deployment.
//   DEMO=1  adds a few extra cards (all playing your first video) so you can judge the library layout.
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const root = path.join(__dirname, '..');
const videos = path.join(root, 'videos');
const web = path.join(root, 'web');
const MIME = {
  '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.mp4': 'video/mp4', '.webm': 'video/webm', '.vtt': 'text/vtt',
  '.json': 'application/json', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
};
const { cleanMessage } = require('../lambda/lib'); // the same message rules as the real sync Lambda
const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

// ---------- files (with Range support, which video seeking needs) ----------
function sendFile(req, res, file) {
  let stat;
  try { stat = fs.statSync(file); if (!stat.isFile()) throw 0; } catch { res.writeHead(404).end('not found'); return; }
  let start = 0, end = stat.size - 1, status = 200;
  const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
  if (m) {
    if (m[1] !== '') { start = +m[1]; if (m[2] !== '') end = Math.min(+m[2], end); }
    else if (m[2] !== '') start = Math.max(0, stat.size - +m[2]); // "last N bytes"
    if (start > end) { res.writeHead(416, { 'content-range': `bytes */${stat.size}` }).end(); return; }
    status = 206;
  }
  const headers = {
    'content-type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
    'accept-ranges': 'bytes',
    'content-length': end - start + 1,
  };
  if (status === 206) headers['content-range'] = `bytes ${start}-${end}/${stat.size}`;
  res.writeHead(status, headers);
  if (req.method === 'HEAD') return res.end();
  fs.createReadStream(file, { start, end }).pipe(res);
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/api/login' && req.method === 'POST') {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ token: 'dev', wsUrl: `ws://${req.headers.host}/ws`, exp: Math.floor(Date.now() / 1000) + 43200 }));
  }

  if (url.pathname.startsWith('/videos/')) {
    let file;
    try { file = path.join(videos, decodeURIComponent(url.pathname.slice('/videos/'.length))); } catch { res.writeHead(400).end(); return; }
    if (!file.startsWith(videos + path.sep)) { res.writeHead(403).end('forbidden'); return; }

    // A .srt next to a missing .vtt is converted on the fly (upload.ps1 does the same before uploading).
    const srt = file.replace(/\.vtt$/, '.srt');
    if (file.endsWith('.vtt') && !fs.existsSync(file) && fs.existsSync(srt)) {
      const text = fs.readFileSync(srt, 'utf8').replace(/^\uFEFF/, '').replace(/(\d\d:\d\d:\d\d),(\d{3})/g, '$1.$2');
      res.writeHead(200, { 'content-type': 'text/vtt' });
      return res.end('WEBVTT\n\n' + text);
    }

    if (process.env.DEMO && file.endsWith('library.json')) {
      let real = [];
      try { real = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {}
      const first = real[0]?.video;
      const extra = first ? ['Holiday 2025', 'Summer in Lisbon', 'Birthday Party', 'Road Trip', 'Weekend Hike']
        .map((title, i) => ({ title, video: `${first}?demo=${i}` })) : [];
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify([...real, ...extra]));
    }
    return sendFile(req, res, file);
  }

  // everything else is a page file from ./web (index.html, style.css, app.js)
  let page;
  try { page = path.join(web, url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname)); } catch { res.writeHead(400).end(); return; }
  if (page.startsWith(web + path.sep)) return sendFile(req, res, page);
  res.writeHead(404).end('not found');
});

// ---------- WebSocket relay (just enough of RFC 6455 for small text messages) ----------
const clients = new Set();

function parseFrame(buf) {
  if (buf.length < 2) return null;
  const opcode = buf[0] & 0x0f;
  const masked = (buf[1] & 0x80) !== 0;
  let len = buf[1] & 0x7f;
  let off = 2;
  if (len === 126) { if (buf.length < 4) return null; len = buf.readUInt16BE(2); off = 4; }
  else if (len === 127) { if (buf.length < 10) return null; len = Number(buf.readBigUInt64BE(2)); off = 10; }
  const mask = masked ? buf.subarray(off, off + 4) : null;
  if (masked) off += 4;
  if (buf.length < off + len) return null; // wait for the rest
  const payload = Buffer.from(buf.subarray(off, off + len));
  if (mask) for (let i = 0; i < len; i++) payload[i] ^= mask[i % 4];
  return { opcode, payload, used: off + len };
}

function frame(opcode, payload) {
  const n = payload.length;
  let head;
  if (n < 126) head = Buffer.from([0x80 | opcode, n]);
  else if (n < 65536) head = Buffer.from([0x80 | opcode, 126, n >> 8, n & 255]);
  else { head = Buffer.alloc(10); head[0] = 0x80 | opcode; head[1] = 127; head.writeBigUInt64BE(BigInt(n), 2); }
  return Buffer.concat([head, payload]);
}

function relay(from, text) {
  let m;
  try { m = JSON.parse(text); } catch { return; }
  const msg = cleanMessage(m);
  if (!msg) return; // unknown types and pings
  const out = frame(1, Buffer.from(JSON.stringify(msg)));
  for (const c of clients) if (c !== from) c.write(out);
}

server.on('upgrade', (req, socket) => {
  const key = req.headers['sec-websocket-key'];
  if (!req.url.startsWith('/ws') || !key) return socket.destroy();
  const accept = crypto.createHash('sha1').update(key + GUID).digest('base64');
  socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
  clients.add(socket);

  let buf = Buffer.alloc(0);
  socket.on('data', (d) => {
    buf = Buffer.concat([buf, d]);
    for (let f; (f = parseFrame(buf)); ) {
      buf = buf.subarray(f.used);
      if (f.opcode === 8) socket.end(frame(8, Buffer.alloc(0)));
      else if (f.opcode === 9) socket.write(frame(10, f.payload));
      else if (f.opcode === 1) relay(socket, f.payload.toString());
    }
  });
  socket.on('close', () => clients.delete(socket));
  socket.on('error', () => socket.destroy());
});

module.exports = { server };

if (require.main === module) {
  const port = process.env.PORT || 8080;
  server.listen(port, () => console.log(`Preview: http://localhost:${port}  (any password works)`));
}
