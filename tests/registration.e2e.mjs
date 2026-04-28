import { test, expect } from '@playwright/test';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(process.cwd());
const indexUrl = pathToFileURL(path.join(ROOT, 'index.html')).href;
const registerUrl = pathToFileURL(path.join(ROOT, 'register.html')).href;

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
    let transactionCalls = 0;

    for (const evt of seedEvents) {
      eventsStore[evt.id] = deepClone(evt);
    }

    function createDocSnapshot(doc) {
      return {
        exists: !!doc,
        data: () => deepClone(doc)
      };
    }

    function makeDocRef(collectionName, docId) {
      return {
        _collectionName: collectionName,
        _docId: docId,
        async get() {
          const source = collectionName === 'events' ? eventsStore : null;
          return createDocSnapshot(source ? source[docId] : null);
        },
        async set(data) {
          if (collectionName === 'events') {
            eventsStore[docId] = deepClone(data);
          }
          if (collectionName === 'registrations') {
            registrationsStore.push(deepClone(data));
          }
        },
        async update(patch) {
          if (collectionName !== 'events' || !eventsStore[docId]) return;
          for (const [key, value] of Object.entries(patch)) {
            if (value && typeof value === 'object' && '__increment' in value) {
              eventsStore[docId][key] = (Number(eventsStore[docId][key]) || 0) + value.__increment;
            } else {
              eventsStore[docId][key] = value;
            }
          }
        },
        async delete() {
          if (collectionName === 'events') {
            delete eventsStore[docId];
          }
        }
      };
    }

    const firestoreApi = {
      collection(name) {
        return {
          async get() {
            if (name === 'events') {
              const docs = Object.values(eventsStore).map((item) => ({
                data: () => deepClone(item)
              }));
              return { empty: docs.length === 0, docs };
            }

            return { empty: true, docs: [] };
          },
          doc(id) {
            const actualId = id || `mock-${Date.now()}-${Math.random()}`;
            return makeDocRef(name, actualId);
          },
          async add(data) {
            if (name === 'registrations') {
              registrationsStore.push(deepClone(data));
            }
          },
          where(field, op, value) {
            return {
              async get() {
                if (name !== 'registrations' || op !== '==') return { docs: [] };
                const docs = registrationsStore
                  .filter((item) => item[field] === value)
                  .map((item) => ({ data: () => deepClone(item) }));
                return { docs };
              }
            };
          }
        };
      },
      async runTransaction(worker) {
        transactionCalls += 1;
        const transaction = {
          async get(ref) {
            return ref.get();
          },
          set(ref, data) {
            return ref.set(data);
          },
          update(ref, patch) {
            return ref.update(patch);
          }
        };
        await worker(transaction);
      }
    };

    window.firebase = {
      initializeApp: () => {},
      firestore: () => firestoreApi
    };
    window.firebase.firestore.FieldValue = {
      increment: (count) => ({ __increment: count })
    };
    window.emailjs = {
      init: () => {},
      send: () => Promise.resolve()
    };

    window.__mockDebug = {
      get transactionCalls() {
        return transactionCalls;
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

test('registration flow uses transaction and stores submission', async ({ page }) => {
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
  expect(debug.transactionCalls).toBeGreaterThan(0);
  expect(debug.registrations.length).toBe(1);
  expect(debug.events['open-1'].currentVolunteers).toBe(1);
});
