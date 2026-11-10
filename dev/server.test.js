const test = require('node:test');
const assert = require('node:assert');
const { server } = require('./server');

test('relays messages to the other sockets, including long ones, and drops pings and empty chat', async () => {
  await new Promise((r) => server.listen(0, r));
  const url = `ws://localhost:${server.address().port}/ws`;
  const open = () => new Promise((res, rej) => { const w = new WebSocket(url); w.onopen = () => res(w); w.onerror = rej; });
  const [a, b, c] = [await open(), await open(), await open()];
  const received = (w, n) => new Promise((res) => {
    const got = [];
    w.onmessage = (e) => { got.push(JSON.parse(e.data)); if (got.length === n) res(got); };
  });

  const bGot = received(b, 3);
  const cGot = received(c, 3);
  a.send(JSON.stringify({ type: 'ping' }));                              // must not be relayed
  a.send(JSON.stringify({ type: 'load', video: 'x'.repeat(199) }));     // >125 bytes: extended length frame
  a.send(JSON.stringify({ type: 'chat', text: '   ' }));                // empty chat is dropped
  a.send(JSON.stringify({ type: 'seek', time: 12.5 }));
  a.send(JSON.stringify({ type: 'chat', name: 'Sam', text: 'hello there', extra: 'ignored' }));

  const expected = [
    { type: 'load', video: 'x'.repeat(199) },
    { type: 'seek', time: 12.5 },
    { type: 'chat', text: 'hello there', name: 'Sam' },
  ];
  assert.deepEqual(await bGot, expected);
  assert.deepEqual(await cGot, expected);

  a.close(); b.close(); c.close();
  server.closeAllConnections();
  server.close();
});
