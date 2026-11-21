'use strict';

/* Pure alarm-scheduling helpers shared by the service worker (importScripts)
 * and the popup (script tag).
 *
 * Alarm definitions are location-agnostic: they only store calendar fields
 * (wall-clock time, weekdays, day-of-month, month-day anchors, explicit
 * dates) and are resolved to absolute epochs at scheduling time. Resolution
 * prefers the Temporal API: wall-clock times are anchored with the UTC
 * offset that is valid on the target date, so DST transitions cannot drift.
 * Where Temporal is unavailable, an equivalent Date-based resolver with the
 * same semantics is used.
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
 */

const schedule = {};

schedule.WEEK = 7 * 24 * 60; // periodInMinutes of a weekly slot

const TEMPORAL = typeof Temporal === 'undefined' ? null : Temporal;

// wall-clock {hours, minutes} on a calendar date (m is 1-12) -> epoch ms
schedule.resolve = (y, m, d, time) => {
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
      })).toZonedDateTimeISO(TEMPORAL.Now.timeZoneId()).epochMilliseconds;
    }
    catch (e) {
      // fall through to the legacy resolver (e.g. unusual zone data)
    }
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

// next occurrence of one weekday at the given wall-clock time
const nextWeeklyDay = (day, time, from) => {
  const base = new Date(from);
  const target = new Date(from);
  target.setDate(base.getDate() + (Number(day) - base.getDay()));
  while (true) {
    const when = schedule.resolve(target.getFullYear(), target.getMonth() + 1, target.getDate(), time);
    if (when > from) {
      return when;
    }
    target.setDate(target.getDate() + 7);
  }
};

// next occurrence of the wall-clock time (today if still ahead, else tomorrow)
const nextDaily = (time, from) => {
  const base = new Date(from);
  let when = schedule.resolve(base.getFullYear(), base.getMonth() + 1, base.getDate(), time);
  if (when <= from) {
    const tomorrow = new Date(from);
    tomorrow.setDate(tomorrow.getDate() + 1);
    when = schedule.resolve(tomorrow.getFullYear(), tomorrow.getMonth() + 1, tomorrow.getDate(), time);
  }
  return when;
};

// next month whose clamped anchor day is still ahead; the anchor itself
// never moves, so clamped months (Jan 31 -> Feb 28) do not compound
const nextMonthly = (day, time, from) => {
  const base = new Date(from);
  let y = base.getFullYear();
  let m = base.getMonth() + 1;
  while (true) {
    const when = schedule.resolve(y, m, day === 'last' ? daysInMonth(y, m) : clampDay(y, m, day), time);
    if (when > from) {
      return when;
    }
    ({y, m} = stepMonth(y, m, 1));
  }
};

// next year whose clamped month-day is still ahead
const nextYearly = (md, time, from) => {
  let y = new Date(from).getFullYear();
  while (true) {
    const when = schedule.resolve(y, Number(md.m), clampDay(y, Number(md.m), Number(md.d)), time);
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
  const time = o.time;
  const out = [];
  if (o.repeat === 'weekly') {
    const days = o.days?.length ? o.days : [new Date(from).getDay()];
    for (const day of days) {
      out.push({
        when: nextWeeklyDay(day, time, from),
        periodInMinutes: schedule.WEEK
      });
    }
  }
  else if (o.repeat === 'daily') {
    out.push({when: nextDaily(time, from)});
  }
  else if (o.repeat === 'monthly') {
    out.push({when: nextMonthly(o.day ?? 1, time, from)});
  }
  else if (o.repeat === 'yearly') {
    out.push({when: nextYearly(o.date ?? {m: 1, d: 1}, time, from)});
  }
  else { // once
    if ((o.dates?.length ?? 0) + (o.days?.length ?? 0) === 0) {
      out.push({when: nextDaily(time, from)});
    }
    else {
      for (const {y, m, d} of (o.dates || [])) {
        const when = schedule.resolve(Number(y), Number(m), Number(d), time);
        if (when > from) {
          out.push({when});
        }
      }
      for (const day of (o.days || [])) {
        const when = nextWeeklyDay(day, time, from);
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

// maps legacy {once, days} definitions onto the repeat model (pure):
// once=true -> 'once' (days become one-shot weekday slots);
// repeating with selected days -> 'weekly'; repeating without days -> 'daily'
schedule.normalize = def => {
  if (def.repeat) {
    return def;
  }
  const o = {...def};
  o.repeat = o.once ? 'once' : ((o.days?.length ?? 0) ? 'weekly' : 'daily');
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
