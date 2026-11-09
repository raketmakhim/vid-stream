const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const { sign, verify, cfCookies } = require('./lib');

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
