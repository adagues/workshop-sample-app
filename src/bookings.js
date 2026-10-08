import { randomUUID } from 'node:crypto';

export class ValidationError extends Error {
  status = 400;
}

export class BookingConflictError extends Error {
  constructor(conflict) {
    super('This room is already booked for part of that time.');
    this.conflict = conflict;
  }
}

function requireRoom(store, roomId) {
  if (!store.rooms.some((room) => room.id === roomId)) {
    throw new ValidationError('Choose an existing room.');
  }
}

function validateField(input, field) {
  if (typeof input[field] !== 'string' || !input[field].trim() || input[field].trim().length > 100) {
    return new ValidationError(`${field === 'title' ? 'Title' : 'Organizer'} must contain 1–100 characters.`);
  }
  return undefined;
}

// Half-open [startTime, endTime) overlap, scoped to the same room; mirrors the
// predicate listBookings already uses so the comparison exists in exactly one place.
export function findConflictingBooking(store, roomId, startTime, endTime) {
  const candidates = store.bookings.filter(
    (booking) => booking.roomId === roomId && startTime < booking.endTime && endTime > booking.startTime
  );
  if (candidates.length === 0) return undefined;
  return candidates.sort((a, b) => a.startTime.localeCompare(b.startTime))[0];
}

function toConflictDetails(booking) {
  return {
    roomId: booking.roomId,
    startTime: booking.startTime,
    endTime: booking.endTime,
    organizer: booking.organizer,
  };
}

function parseTimestamp(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value)) {
    throw new ValidationError('Use UTC timestamps, for example 2030-06-12T09:00:00Z.');
  }
  const date = new Date(value);
  const normalized = value.includes('.') ? value : value.replace('Z', '.000Z');
  if (!Number.isFinite(date.getTime()) || date.toISOString() !== normalized) {
    throw new ValidationError('Enter a valid date and time.');
  }
  return date.toISOString();
}

export function listBookings(store, roomId, date) {
  requireRoom(store, roomId);
  if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new ValidationError('Choose a date in YYYY-MM-DD format.');
  }
  const start = parseTimestamp(`${date}T00:00:00Z`);
  const end = new Date(new Date(start).getTime() + 86_400_000).toISOString();
  return store.bookings
    .filter((booking) => booking.roomId === roomId && booking.startTime < end && booking.endTime > start)
    .sort((a, b) => a.startTime.localeCompare(b.startTime));
}

export function createBooking(store, input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new ValidationError('Provide a booking object.');
  }
  requireRoom(store, input.roomId);
  const startTime = parseTimestamp(input.startTime);
  const endTime = parseTimestamp(input.endTime);
  if (startTime >= endTime) {
    throw new ValidationError('End time must be after start time.');
  }

  // Field validation and conflict detection are independent outcomes of the same
  // request; both are determined before anything is thrown so a response can
  // report either or both (req-combined-validation-and-conflict-errors).
  const fieldError = validateField(input, 'title') ?? validateField(input, 'organizer');
  const conflict = findConflictingBooking(store, input.roomId, startTime, endTime);

  if (fieldError) {
    if (conflict) fieldError.conflict = toConflictDetails(conflict);
    throw fieldError;
  }
  if (conflict) {
    throw new BookingConflictError(toConflictDetails(conflict));
  }

  const booking = {
    id: randomUUID(),
    roomId: input.roomId,
    title: input.title.trim(),
    organizer: input.organizer.trim(),
    startTime,
    endTime,
  };
  store.bookings.push(booking);
  return booking;
}
