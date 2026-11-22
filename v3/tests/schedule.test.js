#!/usr/bin/env node
'use strict';

/* Pure tests for the "once" date handling of data/schedule.js.
 *
 * schedule.slots() drops explicit once-dates whose wall-clock time is
 * already past; with every date in the past it returns [] - the
 * "silently unschedulable" state the popup has to surface (a dead
 * once-alarm renders as an unexplained OFF switch otherwise). Every other
 * repeat mode - and a once-alarm without explicit dates - always resolves
 * a future slot.
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
