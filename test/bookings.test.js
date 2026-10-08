import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  createBooking,
  listBookings,
  findConflictingBooking,
  ValidationError,
  BookingConflictError,
} from '../src/bookings.js';
import { createStore } from '../src/store.js';

function captureError(fn) {
  try {
    fn();
  } catch (error) {
    return error;
  }
  throw new assert.AssertionError({ message: 'Expected function to throw' });
}

const validBooking = {
  roomId: 'cedar',
  title: 'Product brainstorm',
  organizer: 'Alex Morgan',
  startTime: '2030-06-12T09:00:00Z',
  endTime: '2030-06-12T10:00:00Z',
};

test('each store starts with three stable rooms and no bookings', () => {
  const first = createStore();
  assert.deepEqual(first.rooms.map((room) => room.id), ['cedar', 'maple', 'aspen']);
  first.bookings.push({});
  first.rooms[0].name = 'Changed';
  const second = createStore();
  assert.equal(second.bookings.length, 0);
  assert.equal(second.rooms[0].name, 'Cedar');
});

test('creates a booking, trims text, and normalizes UTC timestamps', () => {
  const store = createStore();
  const result = createBooking(store, { ...validBooking, title: '  Product brainstorm  ', ignored: true });
  assert.match(result.id, /^[0-9a-f-]{36}$/);
  assert.deepEqual(result, {
    id: result.id, ...validBooking,
    startTime: '2030-06-12T09:00:00.000Z', endTime: '2030-06-12T10:00:00.000Z',
  });
  assert.equal(store.bookings.length, 1);
});

test('lists only the selected room and date in start-time order', () => {
  const store = createStore();
  const late = createBooking(store, { ...validBooking, startTime: '2030-06-12T14:00:00Z', endTime: '2030-06-12T15:00:00Z' });
  const early = createBooking(store, validBooking);
  createBooking(store, { ...validBooking, roomId: 'maple' });
  createBooking(store, { ...validBooking, startTime: '2030-06-13T09:00:00Z', endTime: '2030-06-13T10:00:00Z' });
  assert.deepEqual(listBookings(store, 'cedar', '2030-06-12').map((booking) => booking.id), [early.id, late.id]);
  assert.deepEqual(listBookings(store, 'cedar', '2030-06-14'), []);
});

test('a booking spanning midnight appears on each affected day, but not after its end', () => {
  const store = createStore();
  const booking = createBooking(store, {
    ...validBooking, startTime: '2030-06-12T23:00:00Z', endTime: '2030-06-14T00:00:00Z',
  });
  assert.deepEqual(listBookings(store, 'cedar', '2030-06-12'), [booking]);
  assert.deepEqual(listBookings(store, 'cedar', '2030-06-13'), [booking]);
  assert.deepEqual(listBookings(store, 'cedar', '2030-06-14'), []);
});

test('accepts a real leap day and millisecond timestamps', () => {
  const booking = createBooking(createStore(), {
    ...validBooking, startTime: '2032-02-29T09:00:00.125Z', endTime: '2032-02-29T10:00:00.125Z',
  });
  assert.equal(booking.startTime, '2032-02-29T09:00:00.125Z');
});

const invalidInputs = [
  ['missing body', undefined],
  ['null body', null],
  ['array body', []],
  ['unknown room', { ...validBooking, roomId: 'missing' }],
  ['missing title', { ...validBooking, title: undefined }],
  ['blank title', { ...validBooking, title: '  ' }],
  ['long title', { ...validBooking, title: 'a'.repeat(101) }],
  ['blank organizer', { ...validBooking, organizer: ' ' }],
  ['non-string organizer', { ...validBooking, organizer: 123 }],
  ['missing timestamp', { ...validBooking, startTime: undefined }],
  ['invalid timestamp', { ...validBooking, startTime: 'not-a-date' }],
  ['missing UTC suffix', { ...validBooking, startTime: '2030-06-12T09:00:00' }],
  ['non-UTC offset', { ...validBooking, startTime: '2030-06-12T09:00:00+02:00' }],
  ['impossible day', { ...validBooking, startTime: '2030-02-30T09:00:00Z' }],
  ['invalid leap day', { ...validBooking, startTime: '2030-02-29T09:00:00Z' }],
  ['impossible hour', { ...validBooking, startTime: '2030-06-12T24:00:00Z' }],
  ['zero duration', { ...validBooking, endTime: validBooking.startTime }],
  ['negative duration', { ...validBooking, endTime: '2030-06-12T08:00:00Z' }],
];

for (const [description, input] of invalidInputs) {
  test(`rejects ${description} without storing a booking`, () => {
    const store = createStore();
    assert.throws(() => createBooking(store, input), ValidationError);
    assert.equal(store.bookings.length, 0);
  });
}

for (const date of [undefined, '', '2030-2-1', '2030-02-30', 'not-a-date']) {
  test(`rejects invalid date filter: ${String(date)}`, () => {
    assert.throws(() => listBookings(createStore(), 'cedar', date), ValidationError);
  });
}

test('rejects an unknown room filter', () => {
  assert.throws(() => listBookings(createStore(), 'missing', '2030-06-12'), ValidationError);
});

test('rejects a booking that overlaps an existing one in the same room, naming the conflict', () => {
  const store = createStore();
  const existing = createBooking(store, validBooking);
  const error = captureError(() =>
    createBooking(store, { ...validBooking, title: 'New meeting', startTime: '2030-06-12T09:30:00Z', endTime: '2030-06-12T10:30:00Z' })
  );
  assert.ok(error instanceof BookingConflictError);
  assert.deepEqual(error.conflict, {
    roomId: existing.roomId,
    startTime: existing.startTime,
    endTime: existing.endTime,
    organizer: existing.organizer,
  });
  assert.equal('title' in error.conflict, false);
  assert.equal(store.bookings.length, 1);
});

test('allows a back-to-back booking starting exactly when the existing one ends', () => {
  const store = createStore();
  const existing = createBooking(store, validBooking);
  const next = createBooking(store, { ...validBooking, startTime: existing.endTime, endTime: '2030-06-12T11:00:00Z' });
  assert.equal(store.bookings.length, 2);
  assert.equal(next.startTime, existing.endTime);
});

test('allows a different room to be booked for the identical time range', () => {
  const store = createStore();
  createBooking(store, validBooking);
  const other = createBooking(store, { ...validBooking, roomId: 'maple' });
  assert.equal(store.bookings.length, 2);
  assert.equal(other.roomId, 'maple');
});

test('reports only the earliest-starting conflict when a request overlaps two existing bookings', () => {
  const store = createStore();
  const later = createBooking(store, { ...validBooking, startTime: '2030-06-12T10:00:00Z', endTime: '2030-06-12T10:30:00Z' });
  const earlier = createBooking(store, { ...validBooking, startTime: '2030-06-12T09:00:00Z', endTime: '2030-06-12T09:20:00Z' });
  const attempt = () =>
    createBooking(store, { ...validBooking, title: 'New meeting', startTime: '2030-06-12T09:15:00Z', endTime: '2030-06-12T10:15:00Z' });
  const first = captureError(attempt);
  assert.ok(first instanceof BookingConflictError);
  assert.equal(first.conflict.startTime, earlier.startTime);
  const second = captureError(attempt);
  assert.deepEqual(second.conflict, first.conflict);
  assert.notEqual(first.conflict.startTime, later.startTime);
});

test('findConflictingBooking returns undefined when no booking overlaps', () => {
  const store = createStore();
  createBooking(store, validBooking);
  assert.equal(
    findConflictingBooking(store, 'cedar', '2030-06-12T11:00:00Z', '2030-06-12T12:00:00Z'),
    undefined
  );
});

test('findConflictingBooking returns the overlapping booking directly, independent of field validation', () => {
  const store = createStore();
  const existing = createBooking(store, validBooking);
  const found = findConflictingBooking(store, 'cedar', '2030-06-12T09:30:00Z', '2030-06-12T10:30:00Z');
  assert.equal(found.id, existing.id);
});

test('reports both a field-validation problem and a conflict when a request has both', () => {
  const store = createStore();
  const existing = createBooking(store, validBooking);
  const error = captureError(() =>
    createBooking(store, { ...validBooking, title: '  ', startTime: '2030-06-12T09:30:00Z', endTime: '2030-06-12T10:30:00Z' })
  );
  assert.ok(error instanceof ValidationError);
  assert.match(error.message, /Title must contain/);
  assert.deepEqual(error.conflict, {
    roomId: existing.roomId,
    startTime: existing.startTime,
    endTime: existing.endTime,
    organizer: existing.organizer,
  });
  assert.equal(store.bookings.length, 1);
});

test('reports only the field-validation problem when there is no conflict', () => {
  const store = createStore();
  const error = captureError(() => createBooking(store, { ...validBooking, title: '  ' }));
  assert.ok(error instanceof ValidationError);
  assert.equal(error.conflict, undefined);
});
