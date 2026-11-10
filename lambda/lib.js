const crypto = require('crypto');

// CloudFront's variant of base64: + = / become - _ ~
const cfB64 = (s) => s.replace(/\+/g, '-').replace(/=/g, '_').replace(/\//g, '~');

const mac = (secret, exp) => crypto.createHmac('sha256', secret).update(String(exp)).digest('hex');

// Token = "<expiry epoch seconds>.<hmac>". Used for the WebSocket connect.
exports.sign = (secret, exp) => `${exp}.${mac(secret, exp)}`;

exports.verify = (secret, token, now = Date.now() / 1000) => {
  const [exp, sig] = String(token).split('.');
  if (!sig || !(Number(exp) > now)) return false;
  const a = Buffer.from(sig);
  const b = Buffer.from(mac(secret, exp));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
};

// Which messages the sync relay forwards, and which fields of them. Anything else is dropped.
// 'ping' (keep-alive) is deliberately absent.
const TYPES = new Set(['play', 'pause', 'seek', 'load', 'state', 'state-request', 'chat']);
exports.cleanMessage = (m) => {
  if (!TYPES.has(m?.type)) return null;
  const msg = { type: m.type };
  if (typeof m.video === 'string' && m.video.length < 200) msg.video = m.video;
  if (Number.isFinite(m.time)) msg.time = m.time;
  if (typeof m.playing === 'boolean') msg.playing = m.playing;
  if (m.type === 'chat') {
    const text = String(m.text ?? '').trim().slice(0, 500);
    if (!text) return null;
    msg.text = text;
    msg.name = String(m.name ?? '').trim().slice(0, 40) || 'Someone';
  }
  return msg;
};

// Custom-policy signed cookies for https://<host>/videos/*
exports.cfCookies = (privateKey, keyPairId, host, exp) => {
  const policy = JSON.stringify({
    Statement: [{ Resource: `https://${host}/videos/*`, Condition: { DateLessThan: { 'AWS:EpochTime': exp } } }],
  });
  const sig = crypto.createSign('RSA-SHA1').update(policy).sign(privateKey, 'base64');
  return {
    'CloudFront-Policy': cfB64(Buffer.from(policy).toString('base64')),
    'CloudFront-Signature': cfB64(sig),
    'CloudFront-Key-Pair-Id': keyPairId,
  };
};

// SSM SecureStrings, cached 5 min so a rotated password applies without a redeploy.
let cache = {};
let at = 0;
exports.getParams = async (...names) => {
  if (Date.now() - at > 300000) { cache = {}; at = Date.now(); }
  const missing = names.filter((n) => !(n in cache));
  if (missing.length) {
    const { SSMClient, GetParametersCommand } = require('@aws-sdk/client-ssm');
    const r = await new SSMClient({}).send(new GetParametersCommand({
      Names: missing.map((n) => `${process.env.PARAM_PREFIX}/${n}`),
      WithDecryption: true,
    }));
    for (const p of r.Parameters) cache[p.Name.split('/').pop()] = p.Value;
  }
  return Object.fromEntries(names.map((n) => [n, cache[n]]));
};
