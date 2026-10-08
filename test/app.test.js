import assert from 'node:assert/strict';
import { once } from 'node:events';
import { test } from 'node:test';
import { JSDOM } from 'jsdom';
import { createServer as createViteServer } from 'vite';
import { createAppServer } from '../src/server.js';

async function waitFor(predicate, { timeout = 2000, interval = 20 } = {}) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const result = predicate();
    if (result) return result;
    if (Date.now() >= deadline) throw new Error('waitFor timed out waiting for a condition to become true.');
    await new Promise((resolve) => setTimeout(resolve, interval));
  }
}

// Renders the real `App` tree (via Vite's SSR module loader, which already carries the
// project's own JSX transform) into a jsdom document, wired to a real ephemeral backend —
// the only way to characterize `BookingForm`/`api()` end to end without exporting them
// or adding test-only code to ui/App.jsx (dec-no-frontend-code-change).
async function renderApp(t) {
  const server = await createAppServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;

  const dom = new JSDOM('<!doctype html><body><div id="root"></div></body>', { url: base });
  const nativeFetch = globalThis.fetch;
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  Object.defineProperty(globalThis, 'navigator', { value: dom.window.navigator, configurable: true });
  globalThis.FormData = dom.window.FormData;
  globalThis.fetch = (path, options) =>
    nativeFetch(typeof path === 'string' && path.startsWith('/api') ? `${base}${path}` : path, options);

  const vite = await createViteServer({
    root: new URL('..', import.meta.url).pathname,
    server: { middlewareMode: true, hmr: false },
    appType: 'custom',
  });
  const { default: App } = await vite.ssrLoadModule('/ui/App.jsx');
  const { default: React } = await import('react');
  const { createRoot } = await import('react-dom/client');

  const root = createRoot(dom.window.document.getElementById('root'));
  root.render(React.createElement(App));

  t.after(async () => {
    root.unmount();
    // React schedules unmount effect cleanups on a later tick; give it one before tearing
    // down the globals those cleanups might still touch.
    await new Promise((resolve) => setTimeout(resolve, 0));
    await vite.close();
    await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    server.closeAllConnections();
    delete globalThis.window;
    delete globalThis.document;
    delete globalThis.FormData;
    globalThis.fetch = nativeFetch;
  });

  return dom.window.document;
}

// Controlled inputs (the date field) use React's own value tracker to detect real changes;
// setting `.value` directly looks like a no-op to that tracker, so onChange never fires.
// Going through the prototype's native setter bypasses the tracker, same as React's own tests do.
function setControlledValue(input, value) {
  Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(input, value);
  input.dispatchEvent(new window.Event('input', { bubbles: true }));
}

async function selectDate(document, value) {
  const dateInput = await waitFor(() => document.querySelector('input[aria-label="Booking date (UTC)"]'));
  setControlledValue(dateInput, value);
  await waitFor(() => dateInput.value === value);
}

// title/organizer/startTime/endTime are uncontrolled (read via FormData on submit), so plain
// `.value` assignment plus a native submit event is enough — this is exactly how a user's
// typed keystrokes land, no synthetic change events required for React to see them.
async function submitBooking(document, { title, organizer, startTime, endTime }) {
  const form = await waitFor(() => document.querySelector('form'));
  form.querySelector('input[name="title"]').value = title;
  form.querySelector('input[name="organizer"]').value = organizer;
  form.querySelector('input[name="startTime"]').value = startTime;
  form.querySelector('input[name="endTime"]').value = endTime;
  form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  return form;
}

const bookingA = { title: 'Design review', organizer: 'Sam Rivera', startTime: '09:00', endTime: '10:00' };
const overlappingBookingB = { title: 'Overlap meeting', organizer: 'Jo Lee', startTime: '09:30', endTime: '10:30' };

test('browser surfaces the server\'s conflict message when a booking overlaps an existing one', async (t) => {
  const document = await renderApp(t);
  await selectDate(document, '2030-06-12');
  await submitBooking(document, bookingA);
  await waitFor(() => document.querySelector('[role="status"].bg-emerald-50'));

  await submitBooking(document, overlappingBookingB);
  const alert = await waitFor(() => document.querySelector('[role="alert"].text-red-800'));

  assert.match(alert.textContent, /2030-06-12T09:00:00\.000Z/);
  assert.match(alert.textContent, /2030-06-12T10:00:00\.000Z/);
  assert.match(alert.textContent, new RegExp(bookingA.organizer));
  assert.match(alert.textContent, new RegExp(bookingA.title));
});

test('preserves the user\'s form entries after a conflict so they can adjust the time and resubmit', async (t) => {
  const document = await renderApp(t);
  await selectDate(document, '2030-06-12');
  await submitBooking(document, bookingA);
  await waitFor(() => document.querySelector('[role="status"].bg-emerald-50'));

  const form = await submitBooking(document, overlappingBookingB);
  await waitFor(() => document.querySelector('[role="alert"].text-red-800'));

  assert.equal(form.querySelector('input[name="title"]').value, overlappingBookingB.title);
  assert.equal(form.querySelector('input[name="organizer"]').value, overlappingBookingB.organizer);
  assert.equal(form.querySelector('input[name="startTime"]').value, overlappingBookingB.startTime);
  assert.equal(form.querySelector('input[name="endTime"]').value, overlappingBookingB.endTime);

  form.querySelector('input[name="startTime"]').value = '10:00';
  form.querySelector('input[name="endTime"]').value = '10:30';
  form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));

  const notice = await waitFor(() => {
    const element = document.querySelector('[role="status"].bg-emerald-50');
    return element?.textContent.includes('Overlap meeting') ? element : undefined;
  });
  assert.match(notice.textContent, /Overlap meeting/);
});
