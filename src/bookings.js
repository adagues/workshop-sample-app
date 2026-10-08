import { randomUUID } from 'node:crypto';

export class ValidationError extends Error {
  status = 400;
}

export class BookingConflictError extends Error {
  status = 409;
}

function requireRoom(store, roomId) {
  if (!store.rooms.some((room) => room.id === roomId)) {
    throw new ValidationError('Choose an existing room.');
  }
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

function findOverlappingBooking(store, roomId, startTime, endTime) {
  return store.bookings.find(
    (existing) => existing.roomId === roomId && existing.startTime < endTime && startTime < existing.endTime
  );
}

function formatConflictMessage(booking) {
  return `This room is already booked by ${booking.organizer} for "${booking.title}" from ${booking.startTime} to ${booking.endTime}.`;
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
  for (const field of ['title', 'organizer']) {
    if (typeof input[field] !== 'string' || !input[field].trim() || input[field].trim().length > 100) {
      throw new ValidationError(`${field === 'title' ? 'Title' : 'Organizer'} must contain 1–100 characters.`);
    }
  }
  const startTime = parseTimestamp(input.startTime);
  const endTime = parseTimestamp(input.endTime);
  if (startTime >= endTime) {
    throw new ValidationError('End time must be after start time.');
  }
  const conflict = findOverlappingBooking(store, input.roomId, startTime, endTime);
  if (conflict) {
    throw new BookingConflictError(formatConflictMessage(conflict));
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
