// LIDOM scoreboard (worker/scores.js). Run with: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { normalizeSchedule, scheduleUrl, drDate, getScores } from '../worker/scores.js';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/lidom-schedule.json', import.meta.url), 'utf8'));
// 2026-10-24 01:30 UTC is still Oct 23, 9:30 p.m. in Santo Domingo.
const NOW = Date.parse('2026-10-24T01:30:00Z');

test('date window is computed in Dominican time (UTC−4)', () => {
  assert.equal(drDate(NOW), '2026-10-23');
  const u = new URL(scheduleUrl(NOW));
  assert.equal(u.searchParams.get('leagueId'), '131');
  assert.equal(u.searchParams.get('startDate'), '2026-10-22');
  assert.equal(u.searchParams.get('endDate'), '2026-10-25');
});

test('normalizes final (extra innings), live, suspended, scheduled and postponed', () => {
  const g = Object.fromEntries(normalizeSchedule(fixture).map((x) => [x.id, x]));
  assert.deepEqual([g[851515].state, g[851515].extra, g[851515].away.runs, g[851515].home.hits], ['final', 10, 6, 12]);
  assert.deepEqual([g[851538].state, g[851538].inning, g[851538].half, g[851538].outs], ['live', 5, 'top', 2]);
  assert.deepEqual([g[851559].state, g[851559].reason, g[851559].inning], ['suspended', 'Rain', 2]);
  assert.equal(g[851559].date, '2026-10-23'); // grouped on the day it resumes
  assert.deepEqual([g[851488].state, g[851488].away.runs, g[851488].away.record, g[851488].home.abbr], ['pre', null, '1-3', 'ESC']);
  assert.deepEqual([g[851487].state, g[851487].reason], ['postponed', 'Rain']);
});

test('games come back grouped by day, then by start time', () => {
  const games = normalizeSchedule(fixture);
  assert.deepEqual(games.map((g) => g.date), ['2026-10-22', '2026-10-23', '2026-10-23', '2026-10-23', '2026-10-24']);
  const today = games.filter((g) => g.date === '2026-10-23').map((g) => g.start);
  assert.deepEqual([...today].sort(), today);
});

test('edge cache: one upstream call, then served from cache', async () => {
  const store = new Map();
  const cache = { match: async (r) => store.get(r.url)?.clone(), put: async (r, res) => store.set(r.url, res) };
  let calls = 0;
  const fetchImpl = async () => (calls++, Response.json(fixture));
  const a = await (await getScores({ fetchImpl, cache, now: NOW })).json();
  const b = await (await getScores({ fetchImpl, cache, now: NOW })).json();
  assert.equal(calls, 1);
  assert.equal(a.games.length, 5);
  assert.deepEqual(a, b);
});

test('upstream failure: empty list, not cached', async () => {
  const store = new Map();
  const cache = { match: async (r) => store.get(r.url), put: async (r, res) => store.set(r.url, res) };
  const res = await getScores({ fetchImpl: async () => new Response('no', { status: 503 }), cache, now: NOW });
  assert.equal(res.status, 502);
  assert.deepEqual((await res.json()).games, []);
  assert.equal(store.size, 0);
});
