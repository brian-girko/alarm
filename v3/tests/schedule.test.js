#!/usr/bin/env node
'use strict';

/* Pure tests for the "once" date handling and the zoned scheduling of
 * data/schedule.js.
 *
 * schedule.slots() drops explicit once-dates whose wall-clock time is
 * already past; with every date in the past it returns [] - the
 * "silently unschedulable" state the popup has to surface (a dead
 * once-alarm renders as an unexplained OFF switch otherwise). Every other
 * repeat mode - and a once-alarm without explicit dates - always resolves
 * a future slot.
 *
 * A definition may carry an IANA zone (zone: "America/New_York"); its
 * calendar fields then read in that zone's wall clock. The zone scenarios
 * derive their expectations from UTC so the suite is independent of the
 * host's own timezone, and cover the properties the feature exists for:
 * a zoned alarm keeps its wall-clock time across the zone's DST changes
 * (the market-open rule), skipped and ambiguous wall-clock times follow
 * the "compatible" rule, and unknown ids fall back to local anchoring.
 *
 * Storage is an untrusted boundary (imported preferences), so the later
 * scenarios pin the shape repair of schedule.normalize: a definition the
 * import left malformed (no time, junk weekdays/anchors, not an object at
 * all) repairs to its documented fallback instead of throwing on a deref
 * or spinning a month/year walker forever.
 *
 * Usage:
 *   node tests/schedule.test.js [data/schedule.js]
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.resolve(__dirname, '..');

const ok = (cond, msg) => {
  if (!cond) {
    throw new Error(msg);
  }
};

// schedule.js runs without the Temporal API here, exercising the
// Date-based resolver (the fallback the worker relies on as well)
const loadSchedule = schedulePath => {
  const src = fs.readFileSync(schedulePath, 'utf8');
  const context = vm.createContext({console});
  return vm.runInContext(src + '\n;schedule;', context, {filename: path.basename(schedulePath)});
};

// Sun 22 Nov 2026, 15:00 local
const NOW = new Date(2026, 10, 22, 15, 0, 0, 0).getTime();
const at = (hours, minutes) => ({hours, minutes});
const day = (y, m, d) => ({y, m, d});
const epoch = (y, m, d, hours, minutes) => new Date(y, m - 1, d, hours, minutes, 0, 0).getTime();

// UTC-derived epochs: the zoned scenarios must not depend on the host's
// own timezone, on either side of the comparison
const uepoch = (y, m, d, hours, minutes) => Date.UTC(y, m - 1, d, hours, minutes);

const scenarios = [
  {
    name: '1. a once-alarm dated today with a past time has no slot',
    run: schedule => {
      const def = {repeat: 'once', time: at(9, 0), dates: [day(2026, 11, 22)]};
      ok(schedule.slots(def, NOW).length === 0, 'the past occurrence was scheduled');
      ok(schedule.next(def, NOW) === undefined, 'next() resolved a past date');
    }
  },
  {
    name: '2. the boundary is strict: a slot exactly at "from" is also past',
    run: schedule => {
      const def = {repeat: 'once', time: at(15, 0), dates: [day(2026, 11, 22)]};
      ok(schedule.slots(def, NOW).length === 0, 'the boundary occurrence was scheduled');
    }
  },
  {
    name: '3. a once-alarm dated today with a future time keeps its slot',
    run: schedule => {
      const def = {repeat: 'once', time: at(16, 0), dates: [day(2026, 11, 22)]};
      const slots = schedule.slots(def, NOW);
      ok(slots.length === 1, 'the future occurrence was dropped');
      ok(slots[0].when === epoch(2026, 11, 22, 16, 0), 'the slot resolved to the wrong epoch');
    }
  },
  {
    name: '4. a once-alarm with mixed dates keeps only the future ones',
    run: schedule => {
      const def = {repeat: 'once', time: at(9, 0), dates: [day(2026, 11, 22), day(2026, 11, 23)]};
      const slots = schedule.slots(def, NOW);
      ok(slots.length === 1, 'the past occurrence was scheduled');
      ok(slots[0].when === epoch(2026, 11, 23, 9, 0), 'the slot resolved to the wrong epoch');
    }
  },
  {
    name: '5. a once-alarm with a weekday slot is never empty',
    run: schedule => {
      const def = {repeat: 'once', time: at(9, 0), dates: [day(2026, 11, 22)], days: [1]};
      const slots = schedule.slots(def, NOW);
      ok(slots.length === 1, 'the weekday occurrence was dropped');
      ok(slots[0].when === epoch(2026, 11, 23, 9, 0), 'the slot resolved to the wrong epoch');
    }
  },
  {
    name: '6. a once-alarm without dates or days rolls to tomorrow',
    run: schedule => {
      const def = {repeat: 'once', time: at(9, 0)};
      const slots = schedule.slots(def, NOW);
      ok(slots.length === 1, 'no slot was scheduled');
      ok(slots[0].when === epoch(2026, 11, 23, 9, 0), 'the slot resolved to the wrong epoch');
    }
  },
  {
    name: '7. recurring modes always resolve a future slot',
    run: schedule => {
      const cases = [
        [{repeat: 'daily', time: at(9, 0)}, epoch(2026, 11, 23, 9, 0)],
        [{repeat: 'weekly', time: at(9, 0), days: [0]}, epoch(2026, 11, 29, 9, 0)],
        [{repeat: 'monthly', time: at(9, 0), day: 22}, epoch(2026, 12, 22, 9, 0)],
        [{repeat: 'yearly', time: at(9, 0), date: {m: 11, d: 22}}, epoch(2027, 11, 22, 9, 0)]
      ];
      for (const [def, when] of cases) {
        const slots = schedule.slots(def, NOW);
        ok(slots.length >= 1, def.repeat + ' resolved no slot');
        ok(slots[0].when === when, def.repeat + ' re-anchored to the wrong epoch');
      }
    }
  },
  {
    name: '8. a legacy once definition (no repeat field) behaves the same',
    run: schedule => {
      const def = {once: true, time: at(9, 0), dates: [day(2026, 11, 22)]};
      ok(schedule.slots(def, NOW).length === 0, 'the past occurrence was scheduled');
      ok(schedule.next(def, NOW) === undefined, 'next() resolved a past date');
    }
  },
  {
    name: '9. a zoned once-alarm resolves in its zone (Asia/Tokyo, UTC+9)',
    run: schedule => {
      const now = uepoch(2026, 11, 22, 3, 0); // 12:00 in Tokyo
      const def = {repeat: 'once', time: at(9, 0), zone: 'Asia/Tokyo'};
      const slots = schedule.slots(def, now);
      ok(slots.length === 1, 'no slot was scheduled in the zone');
      // today\'s 09:00 Tokyo (00:00 UTC) is past, so it rolls to tomorrow
      ok(slots[0].when === uepoch(2026, 11, 23, 0, 0), 'the slot resolved to the wrong epoch');
    }
  },
  {
    name: '10. "today" is judged inside the zone, not on the host clock',
    run: schedule => {
      // 16:30 UTC on Nov 22 is already Nov 23 (Monday) in Tokyo
      const now = uepoch(2026, 11, 22, 16, 30);
      const def = {repeat: 'once', time: at(9, 0), zone: 'Asia/Tokyo'};
      const slots = schedule.slots(def, now);
      ok(slots.length === 1, 'no slot was scheduled in the zone');
      // the zone\'s Nov 23 09:00 (00:00 UTC) is still ahead of "now"
      ok(slots[0].when === uepoch(2026, 11, 23, 0, 0), 'the slot resolved to the wrong epoch');
      const w = schedule.wall(now, 'Asia/Tokyo');
      ok(w.d === 23 && w.hours === 1 && w.minutes === 30 && w.day === 1, 'wall() misread the zone');
    }
  },
  {
    name: '11. a zoned alarm keeps its wall-clock time across a DST fall-back',
    run: schedule => {
      // New York leaves DST on 2026-11-01 06:00 UTC (02:00 EDT -> 01:00 EST)
      const now = uepoch(2026, 11, 1, 3, 0); // still Oct 31, 23:00 EDT there
      const def = {repeat: 'daily', time: at(9, 0), zone: 'America/New_York'};
      const slots = schedule.slots(def, now);
      // the Nov 1 09:00 is after the transition, so it anchors with EST:
      // a stale-offset resolver would land an hour early
      ok(slots[0].when === uepoch(2026, 11, 1, 14, 0), 'the slot did not keep the 09:00 wall-clock in EST');
    }
  },
  {
    name: '12. a wall-clock time skipped by a DST spring-forward shifts forward',
    run: schedule => {
      // New York enters DST on 2026-03-08 07:00 UTC (02:00 EST -> 03:00 EDT);
      // the 02:30 wall-clock does not exist that day
      const now = uepoch(2026, 3, 7, 20, 0); // 15:00 EST Mar 7 there
      const def = {repeat: 'daily', time: at(2, 30), zone: 'America/New_York'};
      const slots = schedule.slots(def, now);
      // "compatible": the 02:30 EST reading jumps the gap to 03:30 EDT
      ok(slots[0].when === uepoch(2026, 3, 8, 7, 30), 'the skipped time did not shift forward');
    }
  },
  {
    name: '13. an ambiguous wall-clock time takes the earlier instant',
    run: schedule => {
      // 01:30 on 2026-11-01 reads twice in New York (01:30 EDT and 01:30 EST);
      // the "compatible" pick is the earlier one
      const now = uepoch(2026, 10, 31, 20, 0); // 16:00 EDT Oct 31 there
      const def = {repeat: 'once', time: at(1, 30), dates: [day(2026, 11, 1)], zone: 'America/New_York'};
      const slots = schedule.slots(def, now);
      ok(slots.length === 1, 'the once-date in the zone was dropped');
      ok(slots[0].when === uepoch(2026, 11, 1, 5, 30), 'the ambiguous time did not take the earlier instant');
    }
  },
  {
    name: '14. weekly, monthly and yearly zones walk the zone calendar',
    run: schedule => {
      // in Tokyo it is already Nov 23 (Monday) at 16:30 UTC on Nov 22
      const now = uepoch(2026, 11, 22, 16, 30);
      const weekly = {repeat: 'weekly', time: at(9, 0), days: [1], zone: 'Asia/Tokyo'};
      ok(schedule.slots(weekly, now)[0].when === uepoch(2026, 11, 23, 0, 0), 'the weekly slot resolved to the wrong epoch');
      const monthly = {repeat: 'monthly', time: at(9, 0), day: 22, zone: 'Asia/Tokyo'};
      // the zone\'s Nov 22 09:00 already passed, so it rolls into December
      ok(schedule.slots(monthly, now)[0].when === uepoch(2026, 12, 22, 0, 0), 'the monthly slot resolved to the wrong epoch');
      const yearly = {repeat: 'yearly', time: at(9, 0), date: {m: 11, d: 23}, zone: 'Asia/Tokyo'};
      ok(schedule.slots(yearly, now)[0].when === uepoch(2026, 11, 23, 0, 0), 'the yearly slot resolved to the wrong epoch');
    }
  },
  {
    name: '15. an unknown zone id falls back to the browser-local anchoring',
    run: schedule => {
      const zoned = schedule.slots({repeat: 'daily', time: at(9, 0), zone: 'Not/AZone'}, NOW);
      const local = schedule.slots({repeat: 'daily', time: at(9, 0)}, NOW);
      ok(zoned.length === 1 && zoned[0].when === local[0].when, 'the unknown zone did not fall back to local');
      ok(schedule.zoneValid('Not/AZone') === false, 'zoneValid accepted an unknown id');
      ok(schedule.zoneValid('UTC') === true, 'zoneValid rejected UTC');
    }
  },
  {
    name: '16. zone helpers read wall-clock fields and offsets',
    run: schedule => {
      const e = uepoch(2026, 11, 22, 16, 30);
      ok(schedule.offset(e, 'Asia/Tokyo') === 540, 'offset() misread Tokyo');
      // Nov 22 2026 is past the US fall-back, so New York is on EST
      ok(schedule.offset(e, 'America/New_York') === -300, 'offset() misread New York (EST)');
      ok(schedule.offset(e, 'Asia/Kolkata') === 330, 'offset() misread the half-hour zone');
    }
  },
  {
    name: '17. a definition without a time repairs to a daily midnight alarm',
    run: schedule => {
      // alarms: [{}] in an imported file: the popup list derefs
      // time.hours (sort and rendering), the worker derefs it in
      // schedule.slots - none of that may throw
      const n = schedule.normalize({});
      ok(n.repeat === 'daily', '{} did not repair to a daily definition');
      ok(n.time.hours === 0 && n.time.minutes === 0, '{} did not repair to 00:00');
      const slots = schedule.slots({});
      ok(slots.length === 1, 'the repaired default scheduled no slot');
      ok(slots[0].when > NOW, 'the repaired default scheduled a past slot');
    }
  },
  {
    name: '18. non-object definitions repair to the default, nothing throws',
    run: schedule => {
      for (const garbage of [null, undefined, 'daily', 42, true, [1, 2]]) {
        const n = schedule.normalize(garbage);
        ok(n && typeof n === 'object' && Array.isArray(n) === false,
          String(garbage) + ' did not normalize to a definition object');
        ok(n.repeat === 'daily', String(garbage) + ' did not repair to daily');
        ok(Number.isInteger(n.time.hours) && Number.isInteger(n.time.minutes),
          String(garbage) + ' did not repair to a usable time');
        ok(schedule.slots(garbage).length === 1, String(garbage) + ' scheduled no slot');
      }
    }
  },
  {
    name: '19. a well-formed definition passes through untouched',
    run: schedule => {
      const def = {id: 'alarm-1', repeat: 'weekly', time: at(9, 0), days: [1, 3], name: 'x'};
      ok(schedule.normalize(def) === def, 'a well-formed definition was copied');
      ok(schedule.normalize(schedule.normalize(def)) === def, 'normalize is not idempotent');
    }
  },
  {
    name: '20. garbage fields repair to their documented fallbacks',
    run: schedule => {
      // time junk reads 00:00; numeric strings and out-of-range values
      // clamp to the clock fields the rendering indexes with
      let n = schedule.normalize({repeat: 'daily', time: '9:00'});
      ok(n.time.hours === 0 && n.time.minutes === 0, 'a string time was not repaired');
      n = schedule.normalize({repeat: 'daily', time: {hours: 30, minutes: 99}});
      ok(n.time.hours === 23 && n.time.minutes === 59, 'out-of-range time was not clamped');
      n = schedule.normalize({repeat: 'daily', time: {hours: '9', minutes: '30'}});
      ok(n.time.hours === 9 && n.time.minutes === 30, 'numeric-string time was not repaired');
      // junk weekdays drop out of days; a valid one keeps its slot
      n = schedule.normalize({repeat: 'weekly', time: at(9, 0), days: ['x', 3, 9, -1]});
      ok(JSON.stringify(n.days) === '[3]',
        'days did not keep only valid weekdays: ' + JSON.stringify(n.days));
      // junk date chips drop out of dates; an anchorable one survives
      n = schedule.normalize({repeat: 'once', time: at(9, 0),
        dates: [day(2026, 11, 23), 'x', 5, {}, {y: 2026, m: 13, d: 1}]});
      ok(JSON.stringify(n.dates) === JSON.stringify([day(2026, 11, 23)]),
        'dates did not keep only anchorable chips: ' + JSON.stringify(n.dates));
      // a monthly anchor outside 1..31 reads the 1st (the junk value used
      // to spin the month walker forever) and the slot resolves
      n = schedule.normalize({repeat: 'monthly', time: at(9, 0), day: 'x'});
      ok(n.day === 1, 'a junk monthly anchor was not repaired');
      n = schedule.normalize({repeat: 'monthly', time: at(9, 0), day: 0});
      ok(n.day === 1, 'a day-0 monthly anchor was not repaired to the 1st');
      n = schedule.normalize({repeat: 'monthly', time: at(9, 0), day: '22'});
      ok(n.day === '22', 'a numeric-string monthly anchor was rewritten');
      ok(schedule.slots({repeat: 'monthly', time: at(9, 0), day: 'x'}, NOW)[0].when ===
        epoch(2026, 12, 1, 9, 0), 'the repaired monthly anchor resolved to the wrong epoch');
      // a yearly anchor reads Jan 1 (the junk value used to spin the year
      // walker forever) and the slot resolves
      n = schedule.normalize({repeat: 'yearly', time: at(9, 0), date: 'x'});
      ok(n.date.m === 1 && n.date.d === 1, 'a junk yearly anchor was not repaired');
      ok(schedule.slots({repeat: 'yearly', time: at(9, 0), date: 'x'}, NOW)[0].when ===
        epoch(2027, 1, 1, 9, 0), 'the repaired yearly anchor resolved to the wrong epoch');
    }
  },
  {
    name: '21. a legacy definition is mapped and repaired in one pass',
    run: schedule => {
      const n = schedule.normalize({once: true, time: at(9, 0), dates: [day(2026, 11, 23)]});
      ok(n.repeat === 'once', 'the legacy once flag was not mapped');
      ok(n.once === undefined, 'the legacy once flag was not deleted');
      const n2 = schedule.normalize({time: at(9, 0), days: [1]});
      ok(n2.repeat === 'weekly', 'the legacy days mapping broke');
      // a legacy definition without a time used to crash slots() with the
      // same undefined deref
      const n3 = schedule.normalize({once: true});
      ok(n3.repeat === 'once' && n3.time.hours === 0 && n3.time.minutes === 0,
        'a legacy definition without a time was not repaired');
      ok(schedule.slots({once: true}, NOW).length === 1,
        'the repaired legacy once-alarm scheduled no slot');
    }
  },
  {
    name: '22. every repeat mode schedules from junk fields without hanging',
    run: schedule => {
      // a junk monthly/yearly anchor never resolves ahead of "from", so
      // the walkers used to spin forever; a repaired shape must terminate
      const junk = {
        once: {once: 'x', time: null, days: null, dates: null},
        daily: {repeat: 'daily', time: {}, days: 'x'},
        weekly: {repeat: 'weekly', time: 0, days: {}},
        monthly: {repeat: 'monthly', time: [], day: null},
        yearly: {repeat: 'yearly', time: NaN, date: []}
      };
      for (const [mode, def] of Object.entries(junk)) {
        const slots = schedule.slots(def, NOW);
        ok(slots.length === 1, mode + ' scheduled ' + slots.length + ' slots from junk');
        ok(slots[0].when > NOW, mode + ' scheduled a past slot from junk');
      }
    }
  },
  {
    name: '23. normalize never mutates the definition it repairs',
    run: schedule => {
      const def = {repeat: 'daily', time: 'junk', days: 'junk', extra: 'keep'};
      const copy = JSON.parse(JSON.stringify(def));
      const n = schedule.normalize(def);
      ok(JSON.stringify(def) === JSON.stringify(copy), 'normalize mutated its input');
      ok(n.extra === 'keep', 'normalize dropped unknown properties');
      ok(n !== def, 'a repaired definition reused the input object');
    }
  }
];

const main = () => {
  const schedulePath = path.resolve(process.argv[2] || path.join(root, 'data/schedule.js'));
  if (fs.existsSync(schedulePath) === false) {
    console.error('schedule.js not found: ' + schedulePath);
    process.exit(2);
  }
  const schedule = loadSchedule(schedulePath);
  let failed = 0;
  for (const s of scenarios) {
    try {
      s.run(schedule);
      console.log('PASS ' + s.name);
    }
    catch (e) {
      failed += 1;
      console.log('FAIL ' + s.name + ' - ' + e.message);
    }
  }
  console.log(failed === 0 ? 'all scenarios passed' : failed + ' scenario(s) failed');
  process.exit(failed === 0 ? 0 : 1);
};

main();
