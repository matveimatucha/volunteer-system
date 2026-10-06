const test = require('node:test');
const assert = require('node:assert/strict');
const { digestDue, dailySlotStartMs } = require('./telegram-bot');

test('interval digest waits three hours', () => {
    const now = Date.UTC(2026, 8, 25, 15, 0, 0);
    assert.equal(digestDue('interval', now - 2 * 60 * 60 * 1000, now), false);
    assert.equal(digestDue('interval', now - 3 * 60 * 60 * 1000, now), true);
    assert.equal(digestDue('interval', 0, now), true);
});

test('daily digest sends once after 21:00 Moscow', () => {
    const slot = dailySlotStartMs(Date.UTC(2026, 8, 25, 18, 30, 0));
    assert.equal(digestDue('daily', slot - 1000, Date.UTC(2026, 8, 25, 17, 0, 0)), false);
    assert.equal(digestDue('daily', slot - 1000, Date.UTC(2026, 8, 25, 18, 30, 0)), true);
    assert.equal(digestDue('daily', slot + 1000, Date.UTC(2026, 8, 25, 18, 40, 0)), false);
});
