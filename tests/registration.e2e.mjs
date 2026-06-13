import { test, expect } from '@playwright/test';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(process.cwd());
const indexUrl = pathToFileURL(path.join(ROOT, 'index.html')).href;
const registerUrl = pathToFileURL(path.join(ROOT, 'register.html')).href;

/**
 * Страницы ходят на серверный API (/api/...), поэтому в тестах
 * подменяем window.fetch мок-сервером с той же логикой ответов.
 */
async function installBrowserMocks(page, events) {
  await page.route('**/*', async (route) => {
    const url = route.request().url();

    if (
      url.includes('firebasejs') ||
      url.includes('gstatic.com') ||
      url.includes('jsdelivr.net')
    ) {
      await route.fulfill({
        status: 200,
        contentType: 'application/javascript',
        body: ''
      });
      return;
    }

    await route.continue();
  });

  await page.addInitScript((seedEvents) => {
    const deepClone = (value) => JSON.parse(JSON.stringify(value));
    const eventsStore = {};
    const registrationsStore = [];
    let registerApiCalls = 0;

    for (const evt of seedEvents) {
      eventsStore[evt.id] = deepClone(evt);
    }

    const isHidden = (ev) =>
      (ev.status || 'open') === 'draft' || ev.isTemplate === true;
    const isClosedForRegistration = (ev) =>
      (ev.status || 'open') === 'closed'
      || (ev.status || 'open') === 'draft'
      || ev.isTemplate === true
      || ev.isArchived === true;

    const jsonResponse = (status, body) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json' }
      });

    const originalFetch = window.fetch ? window.fetch.bind(window) : null;

    window.fetch = async (input, init = {}) => {
      const url = typeof input === 'string' ? input : input.url;
      const method = ((init && init.method) || 'GET').toUpperCase();

      if (!url.includes('/api/')) {
        return originalFetch ? originalFetch(input, init) : jsonResponse(404, {});
      }

      // GET /api/events
      if (method === 'GET' && /\/api\/events(\?.*)?$/.test(url)) {
        const list = Object.values(eventsStore).filter((ev) => !isHidden(ev));
        return jsonResponse(200, { events: deepClone(list) });
      }

      // GET /api/events/:id
      const eventMatch = url.match(/\/api\/events\/([^/?]+)(\?.*)?$/);
      if (method === 'GET' && eventMatch) {
        const ev = eventsStore[decodeURIComponent(eventMatch[1])];
        if (!ev || isHidden(ev)) return jsonResponse(404, { error: 'EVENT_NOT_FOUND' });
        return jsonResponse(200, { event: deepClone(ev) });
      }

      // POST /api/registrations
      if (method === 'POST' && /\/api\/registrations(\?.*)?$/.test(url)) {
        registerApiCalls += 1;
        const payload = JSON.parse(init.body || '{}');
        const ev = eventsStore[payload.eventId];
        if (!ev) return jsonResponse(404, { error: 'EVENT_NOT_FOUND' });
        if (isClosedForRegistration(ev)) {
          return jsonResponse(409, { error: 'REGISTRATION_CLOSED' });
        }

        const max = Number(ev.maxVolunteers) ? Number(ev.maxVolunteers) : 999999;
        const current = Number(ev.currentVolunteers) || 0;
        const asWaitlist = payload.waitlist === true || current >= max;
        const registrationId = `mock-reg-${registrationsStore.length + 1}`;

        registrationsStore.push({
          registrationId,
          eventId: payload.eventId,
          status: asWaitlist ? 'waitlist' : 'confirmed',
          answers: payload.answers || {},
          answersLabeled: payload.answersLabeled || []
        });
        if (!asWaitlist) {
          ev.currentVolunteers = current + 1;
        }

        return jsonResponse(201, {
          registrationId,
          status: asWaitlist ? 'waitlist' : 'confirmed',
          cancelToken: 'mock-token',
          event: deepClone({ ...ev, id: payload.eventId })
        });
      }

      return jsonResponse(404, { error: 'NOT_FOUND' });
    };

    window.emailjs = {
      init: () => {},
      send: () => Promise.resolve()
    };

    window.__mockDebug = {
      get registerApiCalls() {
        return registerApiCalls;
      },
      get registrations() {
        return deepClone(registrationsStore);
      },
      get events() {
        return deepClone(eventsStore);
      }
    };
  }, events);
}

test('index hides registration for closed event', async ({ page }) => {
  await installBrowserMocks(page, [
    {
      id: 'closed-1',
      title: 'Закрытое мероприятие',
      description: 'Описание',
      date: '2099-01-01',
      location: 'Москва',
      maxVolunteers: 10,
      currentVolunteers: 1,
      status: 'closed',
      color: '#ff6b35'
    }
  ]);

  await page.goto(indexUrl);

  const button = page.getByRole('button', { name: 'Регистрация закрыта' });
  await expect(button).toBeDisabled();
});

test('registration flow posts to API and updates counters', async ({ page }) => {
  await installBrowserMocks(page, [
    {
      id: 'open-1',
      title: 'Открытое мероприятие',
      description: 'Описание',
      date: '2099-01-01',
      location: 'Москва',
      maxVolunteers: 10,
      currentVolunteers: 0,
      status: 'open',
      color: '#ff6b35',
      questions: []
    }
  ]);

  await page.goto(`${registerUrl}?event=open-1`);

  await page.fill('input[name="name"]', 'Тестовый Волонтёр');
  await page.fill('input[name="email"]', 'volunteer@example.com');
  await page.fill('input[name="phone"]', '+79991234567');
  await page.click('button[type="submit"]');

  await expect(page.locator('.success-screen')).toContainText('Заявка принята');

  const debug = await page.evaluate(() => window.__mockDebug);
  expect(debug.registerApiCalls).toBe(1);
  expect(debug.registrations.length).toBe(1);
  expect(debug.registrations[0].status).toBe('confirmed');
  expect(debug.events['open-1'].currentVolunteers).toBe(1);
});
