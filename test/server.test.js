import assert from 'node:assert/strict';
import { once } from 'node:events';
import { test } from 'node:test';
import { createAppServer } from '../src/server.js';

async function setup(t) {
  const server = await createAppServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
    server.closeAllConnections();
  }));
  const base = `http://127.0.0.1:${server.address().port}`;
  return (path, options) => fetch(`${base}${path}`, options);
}

const booking = {
  roomId: 'cedar', title: 'Design review', organizer: 'Sam Rivera',
  startTime: '2030-06-12T09:00:00Z', endTime: '2030-06-12T10:00:00Z',
};
const post = (body) => ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

test('API lists rooms, creates a booking, and retrieves it', async (t) => {
  const request = await setup(t);
  const rooms = await request('/api/rooms');
  assert.equal(rooms.status, 200);
  assert.match(rooms.headers.get('content-type'), /application\/json/);
  assert.equal((await rooms.json()).length, 3);
  const created = await request('/api/bookings', post(booking));
  assert.equal(created.status, 201);
  const result = await created.json();
  assert.equal(result.title, booking.title);
  const listed = await request('/api/bookings?roomId=cedar&date=2030-06-12');
  assert.equal(listed.status, 200);
  assert.deepEqual(await listed.json(), [result]);
});

test('API rejects an overlapping booking with 409, a helpful message, and does not mutate the store', async (t) => {
  const request = await setup(t);
  await request('/api/bookings', post(booking));
  const conflicting = await request('/api/bookings', post({ ...booking, title: 'Overlap', organizer: 'Jo Lee' }));
  assert.equal(conflicting.status, 409);
  const body = await conflicting.json();
  assert.equal(Object.keys(body).length, 1);
  assert.match(body.error, /2030-06-12T09:00:00\.000Z/);
  assert.match(body.error, /2030-06-12T10:00:00\.000Z/);
  assert.match(body.error, /Design review/);
  assert.match(body.error, /Sam Rivera/);
  const listed = await request('/api/bookings?roomId=cedar&date=2030-06-12');
  assert.equal((await listed.json()).length, 1);
});

test('API accepts a back-to-back booking that starts exactly when the prior one ends', async (t) => {
  const request = await setup(t);
  await request('/api/bookings', post(booking));
  const nextBooking = { ...booking, startTime: booking.endTime, endTime: '2030-06-12T11:00:00Z' };
  const response = await request('/api/bookings', post(nextBooking));
  assert.equal(response.status, 201);
});

test('API returns useful validation errors and does not create invalid bookings', async (t) => {
  const request = await setup(t);
  const response = await request('/api/bookings', post({ ...booking, endTime: booking.startTime }));
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: 'End time must be after start time.' });
  const listed = await request('/api/bookings?roomId=cedar&date=2030-06-12');
  assert.deepEqual(await listed.json(), []);
});

test('API requires valid room and date filters', async (t) => {
  const request = await setup(t);
  for (const query of ['', '?roomId=missing&date=2030-06-12', '?roomId=cedar&date=2030-02-30']) {
    const response = await request(`/api/bookings${query}`);
    assert.equal(response.status, 400);
    assert.equal(typeof (await response.json()).error, 'string');
  }
});

test('malformed JSON returns 400', async (t) => {
  const request = await setup(t);
  const response = await request('/api/bookings', { ...post(booking), body: '{"title":' });
  assert.equal(response.status, 400);
  assert.match((await response.json()).error, /valid JSON/);
});

test('wrong content type returns 415', async (t) => {
  const request = await setup(t);
  const response = await request('/api/bookings', { method: 'POST', body: '{}' });
  assert.equal(response.status, 415);
});

test('large requests return 413', async (t) => {
  const request = await setup(t);
  const response = await request('/api/bookings', post({ ...booking, title: 'x'.repeat(20_000) }));
  assert.equal(response.status, 413);
});

test('unknown endpoints return JSON 404 and unsupported methods return 405', async (t) => {
  const request = await setup(t);
  assert.equal((await request('/api/missing')).status, 404);
  const response = await request('/api/bookings', { method: 'DELETE' });
  assert.equal(response.status, 405);
  assert.equal(response.headers.get('allow'), 'GET, POST');
});

test('static requests cannot expose application source outside dist', async (t) => {
  const request = await setup(t);
  for (const path of ['/src/server.js', '/..%2fsrc%2fserver.js', '/package.json']) {
    assert.equal((await request(path)).status, 404);
  }
});

test('new server instances do not inherit previous bookings', async (t) => {
  const first = await setup(t);
  await first('/api/bookings', post(booking));
  const second = await setup(t);
  assert.deepEqual(await (await second('/api/bookings?roomId=cedar&date=2030-06-12')).json(), []);
});

test('backend serves no frontend HTML', async (t) => {
  const request = await setup(t);
  const response = await request('/');
  assert.equal(response.status, 404);
  assert.deepEqual(await response.json(), { error: 'API endpoint not found.' });
});

test('parser errors preserve the JSON error contract', async (t) => {
  const request = await setup(t);
  const malformed = await request('/api/bookings', { ...post(booking), body: '{' });
  assert.deepEqual(await malformed.json(), { error: 'Request body must be valid JSON.' });
  const oversized = await request('/api/bookings', post({ ...booking, title: 'x'.repeat(20_000) }));
  assert.deepEqual(await oversized.json(), { error: 'Request body is too large.' });
});

test('routes remain case-sensitive, exact, and limited to their supported methods', async (t) => {
  const request = await setup(t);
  assert.equal((await request('/api/Rooms')).status, 404);
  assert.equal((await request('/api/rooms/')).status, 404);
  const response = await request('/api/rooms', { method: 'HEAD' });
  assert.equal(response.status, 405);
  assert.equal(response.headers.get('allow'), 'GET');
});
