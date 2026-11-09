const crypto = require('crypto');
const { sign, cfCookies, getParams } = require('./lib');

const TTL = 12 * 3600; // seconds the login (cookies + ws token) lasts

const reply = (statusCode, body, cookies) => ({
  statusCode,
  headers: { 'content-type': 'application/json' },
  cookies,
  body: JSON.stringify(body),
});

// Hash first so the compare is constant-time even for different lengths.
const same = (a, b) => {
  const h = (s) => crypto.createHash('sha256').update(String(s)).digest();
  return crypto.timingSafeEqual(h(a), h(b));
};

exports.handler = async (event) => {
  if (event.requestContext.http.method !== 'POST') return reply(405, { error: 'method not allowed' });

  let password, host;
  try {
    const raw = event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString() : event.body;
    ({ password } = JSON.parse(raw));
    host = new URL(event.headers.origin).host; // browsers send Origin on same-site POSTs
  } catch {
    return reply(400, { error: 'bad request' });
  }
  if (!/^[\w.-]+$/.test(host)) return reply(400, { error: 'bad request' });

  const p = await getParams('password', 'cf-private-key', 'hmac-secret');
  if (!p.password || p.password === 'CHANGE_ME') return reply(500, { error: 'password not set in SSM' });

  // shortcut: 1s delay per wrong guess, no real rate limit; add WAF/lockout if the URL gets shared.
  if (!same(password, p.password)) {
    await new Promise((r) => setTimeout(r, 1000));
    return reply(401, { error: 'wrong password' });
  }

  const exp = Math.floor(Date.now() / 1000) + TTL;
  const cookies = Object.entries(cfCookies(p['cf-private-key'], process.env.KEY_PAIR_ID, host, exp)).map(
    ([k, v]) => `${k}=${v}; Path=/; Max-Age=${TTL}; Secure; HttpOnly; SameSite=Lax`,
  );
  return reply(200, { token: sign(p['hmac-secret'], exp), wsUrl: process.env.WS_URL, exp }, cookies);
};
