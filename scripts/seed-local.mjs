// Fills the LOCAL dev KV with the test fixtures, so `npm run preview` shows
// news and episodes without hitting the real feeds. Usage: npm run seed:local
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { refreshAll, KEYS } from '../worker/refresh.js';

const fx = (n) => readFileSync(new URL(`../test/fixtures/${n}`, import.meta.url), 'utf8');
const cfg = {
  maxAgeDays: 3650, maxItems: 150, teams: [],
  feeds: [
    { id: 'mlb-en', name: 'MLB.com', url: 'x/mlb-en.xml', team: 'mlb', lang: 'en' },
    { id: 'nyy-mlb', name: 'MLB.com · Yankees', url: 'x/nyy-mlb.xml', team: 'nyy', lang: 'en' },
    { id: 'nyy-mlbtr', name: 'MLB Trade Rumors', url: 'x/mlbtr-nyy.xml', team: 'nyy', lang: 'en' },
  ],
};
const store = new Map();
const env = { BF_KV: { get: async (k, t) => (store.has(k) ? (t === 'json' ? JSON.parse(store.get(k)) : store.get(k)) : null), put: async (k, v) => store.set(k, v) } };
const fetchImpl = async (u) => new Response(fx(u.includes('youtube') ? 'youtube.xml' : u.split('/').pop()));
await refreshAll(env, cfg, { youtubeChannelId: 'UCvc-JRJ-e-PJRicZkrd_QCQ' }, { fetchImpl, now: Date.parse('2026-10-23T19:00:00Z') });

mkdirSync('.wrangler/seed', { recursive: true });
for (const k of Object.values(KEYS)) {
  const file = `.wrangler/seed/${k.replace(':', '_')}.json`;
  writeFileSync(file, store.get(k));
  execFileSync('npx', ['wrangler', 'kv', 'key', 'put', '--local', '--binding', 'BF_KV', k, '--path', file], { stdio: 'inherit' });
}
console.log('Local KV seeded with fixture data.');
