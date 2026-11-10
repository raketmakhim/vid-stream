const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const { sign, verify, cfCookies, cleanMessage } = require('./lib');

const now = Math.floor(Date.now() / 1000);

test('token round-trips and rejects expired, tampered and junk', () => {
  const t = sign('s3cret', now + 60);
  assert.ok(verify('s3cret', t));
  assert.ok(!verify('other', t));
  assert.ok(!verify('s3cret', sign('s3cret', now - 1)));
  assert.ok(!verify('s3cret', t.replace(/.$/, (c) => (c === 'a' ? 'b' : 'a'))));
  assert.ok(!verify('s3cret', undefined));
  assert.ok(!verify('s3cret', 'abc'));
});

test('CloudFront cookie signature verifies against the public key', () => {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const c = cfCookies(privateKey.export({ type: 'pkcs1', format: 'pem' }), 'KID', 'abc.cloudfront.net', now + 60);
  const unb64 = (s) => Buffer.from(s.replace(/-/g, '+').replace(/_/g, '=').replace(/~/g, '/'), 'base64');
  const policy = unb64(c['CloudFront-Policy']);
  assert.match(policy.toString(), /https:\/\/abc\.cloudfront\.net\/videos\/\*/);
  assert.ok(crypto.createVerify('RSA-SHA1').update(policy).verify(publicKey, unb64(c['CloudFront-Signature'])));
  assert.equal(c['CloudFront-Key-Pair-Id'], 'KID');
});

test('relay keeps only known message types and fields', () => {
  assert.deepEqual(cleanMessage({ type: 'seek', time: 12.5, junk: 'x' }), { type: 'seek', time: 12.5 });
  assert.deepEqual(cleanMessage({ type: 'state', video: 'a.mp4', time: 3, playing: true }), { type: 'state', video: 'a.mp4', time: 3, playing: true });
  assert.equal(cleanMessage({ type: 'ping' }), null);
  assert.equal(cleanMessage({ type: 'nope' }), null);
  assert.equal(cleanMessage(null), null);
  assert.equal(cleanMessage('seek'), null);
});

test('chat messages are trimmed, capped, named and never empty', () => {
  assert.deepEqual(cleanMessage({ type: 'chat', name: ' Sam ', text: ' hi ' }), { type: 'chat', name: 'Sam', text: 'hi' });
  assert.equal(cleanMessage({ type: 'chat', text: 'hi' }).name, 'Someone');
  assert.equal(cleanMessage({ type: 'chat', name: 'x'.repeat(100), text: 'hi' }).name.length, 40);
  assert.equal(cleanMessage({ type: 'chat', text: 'y'.repeat(900) }).text.length, 500);
  assert.equal(cleanMessage({ type: 'chat', text: '   ' }), null);
  assert.equal(cleanMessage({ type: 'chat' }), null);
  assert.equal(cleanMessage({ type: 'chat', text: { a: 1 } }).text, '[object Object]'); // coerced to text, never run as code
});
