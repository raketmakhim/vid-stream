const test = require('node:test');
const assert = require('node:assert');
const { server } = require('./server');

test('relays messages to the other socket, including long ones, and ignores pings', async () => {
  await new Promise((r) => server.listen(0, r));
  const url = `ws://localhost:${server.address().port}/ws`;
  const open = () => new Promise((res, rej) => { const w = new WebSocket(url); w.onopen = () => res(w); w.onerror = rej; });
  const [a, b, c] = [await open(), await open(), await open()];
  const received = (w, n) => new Promise((res) => {
    const got = [];
    w.onmessage = (e) => { got.push(JSON.parse(e.data)); if (got.length === n) res(got); };
  });

  const bGot = received(b, 2);
  const cGot = received(c, 2);
  a.send(JSON.stringify({ type: 'ping' }));                              // must not be relayed
  a.send(JSON.stringify({ type: 'load', video: 'x'.repeat(200) }));     // >125 bytes: extended length frame
  a.send(JSON.stringify({ type: 'seek', time: 12.5 }));

  const expected = [{ type: 'load', video: 'x'.repeat(200) }, { type: 'seek', time: 12.5 }];
  assert.deepEqual(await bGot, expected);
  assert.deepEqual(await cGot, expected);

  a.close(); b.close(); c.close();
  server.closeAllConnections();
  server.close();
});
