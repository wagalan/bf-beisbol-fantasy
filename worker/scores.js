// LIDOM scoreboard from MLB's stats API (league 131, "Liga de Beisbol
// Dominicano", inside sportId 17 "Winter Leagues").
//
// Note: statsapi.mlb.com is public but not an official, documented service,
// and its data is © MLB Advanced Media. The site shows scores with a link
// back to MLB Gameday and can switch the strip off from the CMS
// (Sitio → "Mostrar marcador LIDOM").

export const LIDOM_LEAGUE = 131;
const DR_OFFSET_H = -4; // Dominican Republic: UTC−4 all year, no DST

/** YYYY-MM-DD in Dominican time, shifted by `days`. */
export function drDate(now, days = 0) {
  return new Date(now + DR_OFFSET_H * 3600e3 + days * 864e5).toISOString().slice(0, 10);
}

export function scheduleUrl(now) {
  const q = new URLSearchParams({
    sportId: '17',
    leagueId: String(LIDOM_LEAGUE),
    startDate: drDate(now, -1),
    endDate: drDate(now, 2),
    hydrate: 'linescore,team',
  });
  return `https://statsapi.mlb.com/api/v1/schedule?${q}`;
}

function state(status = {}) {
  const d = String(status.detailedState || '');
  if (/suspend/i.test(d) || status.codedGameState === 'U' || status.codedGameState === 'T') return 'suspended';
  if (/postpon/i.test(d) || status.codedGameState === 'D') return 'postponed';
  if (/cancel/i.test(d) || status.codedGameState === 'C') return 'cancelled';
  if (status.abstractGameState === 'Final') return 'final';
  if (status.abstractGameState === 'Live') return /delay/i.test(d) ? 'delayed' : 'live';
  return 'pre';
}

const num = (v) => (Number.isFinite(v) ? v : null);

function side(t = {}, line = {}) {
  const rec = t.leagueRecord;
  return {
    abbr: String(t.team?.abbreviation || t.team?.teamName || '?').slice(0, 4),
    name: String(t.team?.name || ''),
    runs: num(line.runs ?? t.score),
    hits: num(line.hits),
    errors: num(line.errors),
    record: rec && Number.isFinite(rec.wins) ? `${rec.wins}-${rec.losses}` : null,
  };
}

/** Compact, display-ready games from a statsapi schedule response. */
export function normalizeSchedule(json) {
  const games = [];
  for (const d of json?.dates || []) {
    for (const g of d.games || []) {
      if (!Number.isInteger(g.gamePk)) continue;
      const ls = g.linescore || {};
      const st = state(g.status);
      const sched = ls.scheduledInnings || 9;
      games.push({
        id: g.gamePk,
        // Schedule date, not officialDate: a suspended game is listed on the
        // day it resumes but keeps its original officialDate.
        date: d.date || g.officialDate,
        start: g.gameDate,
        state: st,
        reason: g.status?.reason || null,
        inning: st === 'live' || st === 'suspended' || st === 'delayed' ? num(ls.currentInning) : null,
        half: ls.inningState ? String(ls.inningState).toLowerCase() : null, // top | bottom | middle | end
        outs: st === 'live' ? num(ls.outs) : null,
        // Extra innings on a finished game, shown as FINAL/10.
        extra: st === 'final' && ls.currentInning > sched ? ls.currentInning : null,
        away: side(g.teams?.away, ls.teams?.away),
        home: side(g.teams?.home, ls.teams?.home),
        venue: g.venue?.name || null,
      });
    }
  }
  // By day first (a resumed game keeps its original start time), then by start.
  return games.sort((a, b) => a.date.localeCompare(b.date) || a.start.localeCompare(b.start));
}

/**
 * GET /api/scores. One upstream request per minute at most, whatever the
 * traffic: the normalized answer sits in Cloudflare's edge cache for 60 s.
 * No KV, no cron.
 */
export async function getScores({ fetchImpl = fetch, cache, now = Date.now(), ttl = 60 } = {}) {
  const upstream = scheduleUrl(now);
  const key = new Request(`https://scores.cache/lidom?${drDate(now)}`);
  if (cache) {
    const hit = await cache.match(key);
    if (hit) return hit;
  }
  let body;
  try {
    const res = await fetchImpl(upstream, {
      headers: { accept: 'application/json', 'user-agent': 'BF-Beisbol-Fantasy/1.0 (+https://www.youtube.com/@BeisbolFantasy)' },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    body = { updated: new Date(now).toISOString(), source: 'MLB Advanced Media', games: normalizeSchedule(await res.json()) };
  } catch (e) {
    // Don't cache failures for long; the strip just stays hidden.
    return new Response(JSON.stringify({ updated: null, games: [], error: String(e.message || e).slice(0, 100) }), {
      status: 502,
      headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
    });
  }
  const res = new Response(JSON.stringify(body), {
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': `public, max-age=${ttl}`,
      'access-control-allow-origin': '*',
    },
  });
  if (cache) await cache.put(key, res.clone());
  return res;
}
