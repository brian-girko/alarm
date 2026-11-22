'use strict';

/* Pure alarm-scheduling helpers shared by the service worker (importScripts)
 * and the popup (script tag).
 *
 * Alarm definitions are location-agnostic: they only store calendar fields
 * (wall-clock time, weekdays, day-of-month, month-day anchors, explicit
 * dates) and are resolved to absolute epochs at scheduling time. A
 * definition may also name a time zone (zone: an IANA id such as
 * "America/New_York"): its calendar fields then read in that zone's wall
 * clock, so a "09:30 weekdays, New York" market alarm keeps its
 * wall-clock time across the zone's DST changes. Without a zone - or
 * with an id the runtime cannot anchor to (storage is an untrusted
 * boundary) - the fields read in the browser's local zone, exactly as
 * before.
 *
 * Resolution prefers the Temporal API: wall-clock times are anchored with the
 * UTC offset that is valid on the target date in the target zone, so DST
 * transitions cannot drift; skipped and ambiguous wall-clock times follow
 * Temporal's default "compatible" rule (a skipped time shifts forward by
 * the gap, an ambiguous one takes the earlier instant). Where Temporal is
 * unavailable, an equivalent Date-based resolver with the same semantics is
 * used, deriving zone offsets from cached Intl.DateTimeFormat data.
 *
 * repeat model (schedule.normalize maps legacy {once, days} definitions):
 *   once    one-shot; fires on explicit calendar dates (dates) and/or the
 *           next matching weekdays (days); with neither, at the next
 *           occurrence of the wall-clock time
 *   daily   every day at the given wall-clock time
 *   weekly  every week on the selected weekdays (days)
 *   monthly on a day of month (day: 1-31 or 'last'); shorter months clamp
 *           to their last day (day 31 -> Feb 28)
 *   yearly  on a fixed month-day (date: {m, d}); Feb 29 clamps to 28 in
 *           non-leap years
 *
 * normalize also repairs the deref-critical shapes of untrusted
 * (imported) definitions: a definition that fails the usable contract is
 * rebuilt with its documented fallback (00:00, dropped junk chips, 1st /
 * Jan 1 anchors) instead of throwing on a missing time or spinning a
 * month/year walker forever on an unanchorable one.
 */

const schedule = {};

schedule.WEEK = 7 * 24 * 60; // periodInMinutes of a weekly slot

const TEMPORAL = typeof Temporal === 'undefined' ? null : Temporal;

// cached Intl formatters (one per zone): the Date-based zone reader and
// resolver go through Intl, and formatter construction is far too
// expensive to repeat for every resolved slot
const formatters = new Map();
const formatter = zone => {
  if (formatters.has(zone) === false) {
    // throws RangeError on ids Intl cannot anchor to; callers treat
    // that as "unknown zone" and fall back to the local one
    formatters.set(zone, new Intl.DateTimeFormat('en-US', {
      timeZone: zone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23'
    }));
  }
  return formatters.get(zone);
};

// true when the id names a zone the runtime can anchor to; the resolvers
// use it to choose between zone and local anchoring, the popup uses it to
// keep imported garbage from rendering as a zone tag
schedule.zoneValid = zone => {
  try {
    formatter(zone);
    return true;
  }
  catch (e) {
    return false;
  }
};

// wall-clock fields of an epoch read through Intl (throws on unknown
// ids; schedule.wall catches). day is the weekday, 0 = Sunday
const zoneFields = (e, zone) => {
  const parts = {};
  for (const p of formatter(zone).formatToParts(new Date(e))) {
    parts[p.type] = p.value;
  }
  const y = Number(parts.year);
  const m = Number(parts.month);
  const d = Number(parts.day);
  return {
    y,
    m,
    d,
    hours: Number(parts.hour) % 24,
    minutes: Number(parts.minute),
    day: new Date(Date.UTC(y, m - 1, d)).getUTCDay()
  };
};

// wall-clock fields of an epoch in the alarm's zone ({y, m, d, hours,
// minutes, day}); an unknown (or missing) zone reads the browser's local
// fields, so a definition with garbage in storage still schedules like a
// local one everywhere
schedule.wall = (e, zone) => {
  if (zone) {
    if (TEMPORAL) {
      try {
        const z = TEMPORAL.Instant.fromEpochMilliseconds(e).toZonedDateTimeISO(zone);
        return {
          y: z.year,
          m: z.month,
          d: z.day,
          hours: z.hour,
          minutes: z.minute,
          day: z.dayOfWeek % 7 // Temporal counts Mon=1..Sun=7
        };
      }
      catch (err) {
        // fall through to the Intl reader (also covers rejected ids)
      }
    }
    try {
      return zoneFields(e, zone);
    }
    catch (err) {
      // fall through to the local read
    }
  }
  const t = new Date(e);
  return {
    y: t.getFullYear(),
    m: t.getMonth() + 1,
    d: t.getDate(),
    hours: t.getHours(),
    minutes: t.getMinutes(),
    day: t.getDay()
  };
};

// the zone's UTC offset at an epoch, in minutes east of UTC (the local
// zone's when the id is unknown); modern offsets are whole minutes
schedule.offset = (e = Date.now(), zone) => {
  const w = schedule.wall(e, zone);
  // the wall fields are minute-granular, so compare against the epoch
  // floored to the minute; round absorbs pre-1900 fractional offsets
  return Math.round((Date.UTC(w.y, w.m - 1, w.d, w.hours, w.minutes) - Math.floor(e / 60000) * 60000) / 60000);
};

// wall-clock fields of an epoch folded back into an "as-if-UTC"
// timestamp: wallAsUTC(c, zone) === target is what "the clock reads
// target there" means
const wallAsUTC = (e, zone) => {
  const w = schedule.wall(e, zone);
  return Date.UTC(w.y, w.m - 1, w.d, w.hours, w.minutes);
};

// epoch of a wall-clock time anchored in a zone without Temporal: the
// target is read as if it were UTC, then rebased on the offset each
// candidate lands in; a fixed-offset zone converges after one round and
// a DST boundary settles onto the candidates around the transition.
// Matches Temporal's "compatible" rule: an ambiguous time takes the
// earlier instant, a skipped one keeps the pre-transition offset (its
// wall clock then reads the target shifted forward by the gap)
const resolveZone = (y, m, d, time, zone) => {
  const target = Date.UTC(y, m - 1, d, Number(time.hours), Number(time.minutes));
  const reads = c => wallAsUTC(c, zone) === target;
  const candidates = [];
  let when = target;
  for (let round = 0; round < 3; round += 1) {
    when = target - (wallAsUTC(when, zone) - when);
    if (candidates.includes(when) === false) {
      candidates.push(when);
    }
  }
  const valid = candidates.filter(reads);
  if (valid.length) {
    // an ambiguous (fold) time also reads on the pre-transition side at
    // an earlier instant, and the iteration may have landed on either
    // side; DST offsets move in 15-minute steps, so probe the earlier
    // instants for the "compatible" pick
    let found = Math.min(...valid);
    for (let step = 15; step <= 120; step += 15) {
      if (reads(found - step * 60000)) {
        return found - step * 60000;
      }
    }
    return found;
  }
  // skipped (gap): the candidate past the transition kept the
  // pre-transition offset, so its wall clock reads the target shifted
  // by the gap - the "compatible" shift-forward result
  return Math.min(...candidates.filter(c => wallAsUTC(c, zone) > target));
};

// wall-clock {hours, minutes} on a calendar date (m is 1-12) -> epoch ms,
// anchored in the given zone (an id the runtime rejects falls back to
// the browser's local zone)
schedule.resolve = (y, m, d, time, zone) => {
  if (TEMPORAL) {
    try {
      return TEMPORAL.PlainDate.from({
        year: y,
        month: m,
        day: d
      }).toPlainDateTime(TEMPORAL.PlainTime.from({
        hour: Number(time.hours),
        minute: Number(time.minutes),
        second: 0
      })).toZonedDateTimeISO(zone || TEMPORAL.Now.timeZoneId()).epochMilliseconds;
    }
    catch (e) {
      // fall through to the legacy resolver (e.g. unusual zone data or
      // an id Temporal rejects)
    }
  }
  if (zone && schedule.zoneValid(zone)) {
    return resolveZone(y, m, d, time, zone);
  }
  return new Date(y, m - 1, d, Number(time.hours), Number(time.minutes), 0, 0).getTime();
};

const daysInMonth = (y, m) => new Date(y, m, 0).getDate();

// monthly/yearly anchors clamp to the last day of shorter months
const clampDay = (y, m, day) => Math.min(Number(day), daysInMonth(y, m));

const stepMonth = (y, m, n) => {
  const t = m - 1 + n;
  return {
    y: y + Math.floor(t / 12),
    m: ((t % 12) + 12) % 12 + 1
  };
};

// pure calendar arithmetic on {y, m, d}: anchored in UTC so neither the
// browser's zone nor the alarm's can shift a walked date; the zoned
// occurrence walkers use it on dates read through schedule.wall
const calendarUTC = p => Date.UTC(p.y, p.m - 1, p.d);
const addDays = (p, n) => {
  const t = new Date(calendarUTC(p) + n * 86400000);
  return {y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate()};
};
const weekday = p => new Date(calendarUTC(p)).getUTCDay();

// next occurrence of one weekday at the given wall-clock time, walked on
// the calendar dates of the alarm's zone
const nextWeeklyDay = (day, time, from, zone) => {
  const base = schedule.wall(from, zone);
  let p = addDays(base, (Number(day) - weekday(base) + 7) % 7);
  while (true) {
    const when = schedule.resolve(p.y, p.m, p.d, time, zone);
    if (when > from) {
      return when;
    }
    p = addDays(p, 7);
  }
};

// next occurrence of the wall-clock time (today in the zone if still
// ahead, else tomorrow there)
const nextDaily = (time, from, zone) => {
  const base = schedule.wall(from, zone);
  let when = schedule.resolve(base.y, base.m, base.d, time, zone);
  if (when <= from) {
    const tomorrow = addDays(base, 1);
    when = schedule.resolve(tomorrow.y, tomorrow.m, tomorrow.d, time, zone);
  }
  return when;
};

// next month (of the zone's calendar) whose clamped anchor day is still
// ahead; the anchor itself never moves, so clamped months (Jan 31 ->
// Feb 28) do not compound
const nextMonthly = (day, time, from, zone) => {
  let {y, m} = schedule.wall(from, zone);
  while (true) {
    const when = schedule.resolve(y, m, day === 'last' ? daysInMonth(y, m) : clampDay(y, m, day), time, zone);
    if (when > from) {
      return when;
    }
    ({y, m} = stepMonth(y, m, 1));
  }
};

// next year (of the zone's calendar) whose clamped month-day is ahead
const nextYearly = (md, time, from, zone) => {
  let y = schedule.wall(from, zone).y;
  while (true) {
    const when = schedule.resolve(y, Number(md.m), clampDay(y, Number(md.m), Number(md.d)), time, zone);
    if (when > from) {
      return when;
    }
    y += 1;
  }
};

// upcoming slots to register with chrome.alarms, sorted by time;
// recurring single-slot modes (daily/monthly/yearly) schedule one one-shot
// and are rescheduled on fire from their wall-clock definition, since fixed
// periods (24h, 30d, 365d) would drift across DST changes and month lengths
schedule.slots = (def, from = Date.now()) => {
  const o = schedule.normalize(def);
  // optional IANA id; unknown ids anchor locally at resolve time
  const zone = o.zone;
  const time = o.time;
  const out = [];
  if (o.repeat === 'weekly') {
    const days = o.days?.length ? o.days : [schedule.wall(from, zone).day];
    for (const day of days) {
      out.push({
        when: nextWeeklyDay(day, time, from, zone),
        periodInMinutes: schedule.WEEK
      });
    }
  }
  else if (o.repeat === 'daily') {
    out.push({when: nextDaily(time, from, zone)});
  }
  else if (o.repeat === 'monthly') {
    out.push({when: nextMonthly(o.day ?? 1, time, from, zone)});
  }
  else if (o.repeat === 'yearly') {
    out.push({when: nextYearly(o.date ?? {m: 1, d: 1}, time, from, zone)});
  }
  else { // once
    if ((o.dates?.length ?? 0) + (o.days?.length ?? 0) === 0) {
      out.push({when: nextDaily(time, from, zone)});
    }
    else {
      for (const {y, m, d} of (o.dates || [])) {
        const when = schedule.resolve(Number(y), Number(m), Number(d), time, zone);
        if (when > from) {
          out.push({when});
        }
      }
      for (const day of (o.days || [])) {
        const when = nextWeeklyDay(day, time, from, zone);
        if (out.some(s => s.when === when) === false) {
          out.push({when});
        }
      }
    }
  }
  return out.sort((a, b) => a.when - b.when);
};

// first upcoming occurrence (epoch ms)
schedule.next = (def, from = Date.now()) => schedule.slots(def, from)[0]?.when;

// the shape contract a stored definition must satisfy to pass through
// normalize untouched: consumers deref time.{hours,minutes} directly (the
// popup's sort and list rendering, the worker's slot rebuilds) and the
// resolvers walk days/dates/day/date. junk in those fields either throws
// (a missing time) or spins a month/year walker forever (an unanchorable
// anchor never resolves ahead of "from")
const timeOK = t => t !== null && typeof t === 'object' && Array.isArray(t) === false &&
  Number.isInteger(t.hours) && t.hours >= 0 && t.hours <= 23 &&
  Number.isInteger(t.minutes) && t.minutes >= 0 && t.minutes <= 59;

// a weekday slot: integer 0..6 after the Number() coercion the
// definitions already rely on (PILL/DAYS are indexed with it)
const weekdayOK = d => {
  const n = Number(d);
  return Number.isInteger(n) && n >= 0 && n <= 6;
};

// a once-mode date chip the resolvers can anchor: {y, m, d} with a finite
// year, month 1..12 and day 1..31 (junk chips would render as
// "undefined undefined" and resolve to NaN)
const dateChipOK = d => {
  if (d === null || typeof d !== 'object' || Array.isArray(d)) {
    return false;
  }
  const m = Number(d.m);
  const day = Number(d.d);
  return Number.isFinite(Number(d.y)) && Number.isInteger(m) && m >= 1 && m <= 12 &&
    Number.isInteger(day) && day >= 1 && day <= 31;
};

// a monthly anchor: 1..31 or the 'last' marker
const monthDayOK = day => day === 'last' ||
  (Number.isInteger(Number(day)) && Number(day) >= 1 && Number(day) <= 31);

// a yearly anchor: {m: 1..12, d: 1..31}
const yearDayOK = md => md !== null && typeof md === 'object' && Array.isArray(md) === false &&
  Number.isInteger(Number(md.m)) && Number(md.m) >= 1 && Number(md.m) <= 12 &&
  Number.isInteger(Number(md.d)) && Number(md.d) >= 1 && Number(md.d) <= 31;

// absent fields are fine (the resolvers default them), present junk is not
const daysOK = days => days === undefined || days === null ||
  (Array.isArray(days) && days.every(weekdayOK));
const datesOK = dates => dates === undefined || dates === null ||
  (Array.isArray(dates) && dates.every(dateChipOK));
const anchorOK = (v, ok) => v === undefined || v === null || ok(v);

// true when the value is a definition every consumer can use as stored
const usable = def => def !== null && typeof def === 'object' && Array.isArray(def) === false &&
  Boolean(def.repeat) && timeOK(def.time) &&
  daysOK(def.days) && datesOK(def.dates) &&
  anchorOK(def.day, monthDayOK) && anchorOK(def.date, yearDayOK);

// maps legacy {once, days} definitions onto the repeat model (pure):
// once=true -> 'once' (days become one-shot weekday slots);
// repeating with selected days -> 'weekly'; repeating without days -> 'daily'
//
// storage is an untrusted boundary (imported preferences): a definition
// that fails the usable contract is rebuilt on a copy with guaranteed
// shapes instead of crashing or hanging a consumer - the wall-clock time
// clamps to 0..23:0..59 (garbage reads 00:00), junk weekday/date chips are
// dropped, junk monthly/yearly anchors read the 1st / Jan 1. the repair
// never invents an id (identity is the caller's business) and never
// mutates its input; a well-formed definition keeps its exact reference.
schedule.normalize = def => {
  if (usable(def)) {
    return def;
  }
  const o = def !== null && typeof def === 'object' && Array.isArray(def) === false ? {...def} : {};
  if (timeOK(o.time) === false) {
    const int = v => {
      const n = Math.floor(Number(v));
      return Number.isFinite(n) ? n : 0;
    };
    o.time = {
      hours: Math.min(23, Math.max(0, int(o.time?.hours))),
      minutes: Math.min(59, Math.max(0, int(o.time?.minutes)))
    };
  }
  if (daysOK(o.days) === false) {
    o.days = Array.isArray(o.days) ? o.days.map(Number).filter(weekdayOK) : [];
  }
  if (datesOK(o.dates) === false) {
    o.dates = Array.isArray(o.dates) ? o.dates.filter(dateChipOK) : [];
  }
  if (o.day !== undefined && o.day !== null && monthDayOK(o.day) === false) {
    const n = Math.floor(Number(o.day));
    o.day = Number.isInteger(n) ? Math.min(31, Math.max(1, n)) : 1;
  }
  if (o.date !== undefined && o.date !== null && yearDayOK(o.date) === false) {
    o.date = {m: 1, d: 1};
  }
  o.repeat = o.repeat || (o.once ? 'once' : ((o.days?.length ?? 0) ? 'weekly' : 'daily'));
  delete o.once;
  return o;
};

// minimal ISO date (YYYY-MM-DD) parsing without Date-parsing pitfalls
schedule.parseISO = (iso = '') => {
  const [y, m, d] = iso.split('-').map(Number);
  return y && m && d ? {y, m, d} : null;
};

// ISO date string from calendar fields (m is 1-12)
schedule.toISO = (y, m, d) => y + '-' + ('0' + m).substr(-2) + '-' + ('0' + d).substr(-2);
