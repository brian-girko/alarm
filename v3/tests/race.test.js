#!/usr/bin/env node
'use strict';

/* Regression harness for the 'alarms-storage' single-writer queue in
 * worker.js.
 *
 * Loads data/schedule.js plus a worker file into a vm context with a
 * stubbed chrome API whose storage get/set callbacks can be held and
 * released in a chosen order, then replays the interleavings that used
 * to drop or resurrect mirror entries. The storage stub deep-clones on
 * every read and write, like the real structured-clone boundary.
 *
 * Usage:
 *   node tests/race.test.js [worker.js]
 *
 * Scenarios 1-5 and 7 fail on the pre-fix worker (they demonstrate the
 * lost updates and the stale popup re-render); scenario 6 guards the
 * common snooze path and passes on both. Scenario 8 guards the
 * fired-slots log (added with the once-alarm "passed" surfacing) that
 * the popup reads to tell a rung once-date from one that never got
 * scheduled. Scenarios 9-12 guard the restore pass behind the
 * 'restore-alarms' message (import/reset) and the startup sweep of
 * live orphans. Scenarios 13-14 guard the snooze sweep on
 * disable/delete: a key's pending snoozes join the flush's clear scan
 * ('audio-<id>/N' is the only shape in use today; the slot-shaped
 * 'audio-<id>:<slot>/N' is defensive), and scenario 14 pins the
 * delimiters that keep a prefix-colliding id's snoozes ('alarm-0.8'
 * vs 'alarm-0.81') untouched. To see the pre-fix failures:
 *   cp worker.js /tmp/worker.old.js   # before applying the fix
 *   node tests/race.test.js /tmp/worker.old.js
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.resolve(__dirname, '..');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const clone = o => JSON.parse(JSON.stringify(o));
const ok = (cond, msg) => {
  if (!cond) {
    throw new Error(msg);
  }
};

// listener hub shared by all stubbed chrome events
const hub = () => {
  const ls = [];
  return {
    addListener: l => ls.push(l),
    removeListener: () => {},
    fire: (...args) => ls.map(l => l(...args))
  };
};

// chrome.storage.local with holdable get/set callbacks; while held, an
// operation only takes effect when the harness releases it by index
const makeStorage = () => {
  const store = {};
  const onChanged = hub();
  const ops = [];
  let hold = false;

  const push = op => {
    ops.push(op);
    if (hold === false) {
      op.run();
    }
  };

  const local = {
    get(defs, cb) {
      return new Promise(resolve => {
        push({
          kind: 'get',
          keys: Object.keys(defs),
          done: false,
          run() {
            this.done = true;
            const out = clone(defs);
            for (const k of Object.keys(defs)) {
              if (k in store) {
                out[k] = clone(store[k]);
              }
            }
            if (cb) {
              cb(out);
            }
            resolve(out);
          }
        });
      });
    },
    set(obj, cb) {
      return new Promise(resolve => {
        push({
          kind: 'set',
          keys: Object.keys(obj),
          payload: clone(obj),
          done: false,
          run() {
            this.done = true;
            const changes = {};
            for (const [k, v] of Object.entries(this.payload)) {
              if (JSON.stringify(store[k]) !== JSON.stringify(v)) {
                changes[k] = {newValue: clone(v)};
              }
              store[k] = clone(v);
            }
            if (cb) {
              cb();
            }
            resolve();
            if (Object.keys(changes).length) {
              onChanged.fire(changes);
            }
          }
        });
      });
    }
  };

  return {
    local,
    onChanged,
    hold(v = true) {
      hold = v;
    },
    pending() {
      const out = [];
      ops.forEach((o, i) => {
        if (o.done === false) {
          out.push({i, kind: o.kind, keys: o.keys});
        }
      });
      return out;
    },
    run(i) {
      if (ops[i] && ops[i].done === false) {
        ops[i].run();
      }
    },
    seed(obj) {
      Object.assign(store, clone(obj));
    },
    mirror() {
      return store['alarms-storage'];
    },
    // deep copy of any stored key, for assertions beyond the mirror
    read(key) {
      return clone(store[key]);
    },
    drain() {
      ops.forEach((o, i) => this.run(i));
    }
  };
};

// chrome.alarms with an audited create log; fire() mimics the browser
// dropping a one-shot after it rings
const makeAlarms = () => {
  const map = new Map();
  const onAlarm = hub();
  const calls = [];
  const gates = []; // deferred create/clear jobs awaiting release
  let defer = false;
  const create = (name, info = {}) => {
    calls.push(name);
    const apply = () => map.set(name, {name, ...clone(info), scheduledTime: info.when ?? Date.now()});
    if (defer) {
      return new Promise(resolve => gates.push(() => {
        apply();
        resolve(true);
      }));
    }
    apply();
    return Promise.resolve(true);
  };
  const clear = name => {
    if (defer) {
      return new Promise(resolve => gates.push(() => {
        resolve(map.delete(name));
      }));
    }
    return Promise.resolve(map.delete(name));
  };
  return {
    map,
    onAlarm,
    calls,
    create,
    clear,
    // hold chrome.alarms create/clear back until settleJobs() releases
    // them, like browser IPC that has not landed yet
    defer(v = true) {
      defer = v;
    },
    settleJobs() {
      while (gates.length) {
        gates.shift()();
      }
    },
    get(name, cb) {
      const o = map.has(name) ? clone(map.get(name)) : undefined;
      if (cb) {
        cb(o);
      }
      return Promise.resolve(o);
    },
    getAll(cb) {
      const as = [...map.values()].map(clone);
      if (cb) {
        cb(as);
      }
      return Promise.resolve(as);
    },
    fire(name) {
      const o = map.get(name) || {name};
      map.delete(name);
      onAlarm.fire(clone(o));
    }
  };
};

const buildChrome = (storage, alarms) => ({
  runtime: {
    lastError: null,
    onStartup: hub(),
    onInstalled: hub(),
    onMessage: hub(),
    onCommand: hub(),
    sendMessage(m, cb) {
      if (cb) {
        cb();
      }
      return Promise.resolve();
    },
    getURL: s => 'chrome-extension://test/' + s,
    getManifest: () => ({name: 'test', version: '0'}),
    setUninstallURL: () => {}
  },
  storage: {local: storage.local, onChanged: storage.onChanged},
  alarms,
  windows: {
    create: () => Promise.resolve({}),
    update: () => Promise.resolve(),
    getCurrent: () => Promise.resolve({left: 0, top: 0, width: 800, height: 600})
  },
  action: {
    setBadgeText: () => Promise.resolve(),
    setBadgeBackgroundColor: () => Promise.resolve(),
    setBadgeTextColor: () => Promise.resolve(),
    setPopup: () => Promise.resolve(),
    onClicked: hub()
  },
  idle: {onStateChanged: hub()},
  contextMenus: {create: () => {}, onClicked: hub()},
  commands: {onCommand: hub()},
  tabs: {
    update: () => Promise.resolve(),
    query: async () => [],
    create: () => Promise.resolve()
  },
  management: {getSelf: cb => cb && cb({installType: 'development'})}
});

// mirrors the Firefox background.scripts order: schedule.js defines
// its helpers in the same scope right before the worker runs
const loadWorker = async workerPath => {
  const scheduleSrc = fs.readFileSync(path.join(root, 'data/schedule.js'), 'utf8');
  const workerSrc = fs.readFileSync(workerPath, 'utf8');
  const storage = makeStorage();
  const alarms = makeAlarms();
  const chrome = buildChrome(storage, alarms);
  const context = vm.createContext({
    chrome,
    console,
    setTimeout,
    clearTimeout,
    URLSearchParams,
    // webdriver:true skips the FAQ/uninstall block at load time
    navigator: {webdriver: true}
  });
  vm.runInContext(scheduleSrc + '\n;' + workerSrc, context, {filename: path.basename(workerPath)});
  // let the load-time badge pass settle before a scenario holds storage
  await sleep(30);
  return {storage, alarms, chrome};
};

// drive the worker through the message/context-menu surfaces it uses
const setAlarm = (chrome, name, when) =>
  chrome.runtime.onMessage.fire({method: 'set-alarm', name, info: {when}}, {}, () => {});
const clearAlarm = (chrome, name) =>
  chrome.runtime.onMessage.fire({method: 'clear-alarm', name}, {}, () => {});
const removeAll = chrome =>
  chrome.contextMenus.onClicked.fire({menuItemId: 'remove-all-alarms'});

const runOldest = (storage, kind) => {
  const op = storage.pending().find(o => o.kind === kind);
  if (op === undefined) {
    return false;
  }
  storage.run(op.i);
  return true;
};

// release every pending read, let their continuations spawn writes,
// then release the writes; repeats until nothing new appears. For the
// pre-fix worker this lands the stalest snapshot LAST, which is the
// lost-update ordering the race produces in the wild
const settle = async storage => {
  for (let round = 0; round < 10; round += 1) {
    let acted = false;
    while (runOldest(storage, 'get')) {
      acted = true;
    }
    await sleep(5);
    while (runOldest(storage, 'set')) {
      acted = true;
    }
    await sleep(5);
    if (acted === false) {
      break;
    }
  }
  storage.drain();
  await sleep(5);
  storage.drain();
};

const scenarios = [
  {
    id: 1,
    name: '1. a flush landing while an alarm fires keeps the flushed entry',
    run: async workerPath => {
      const {storage, alarms, chrome} = await loadWorker(workerPath);
      storage.seed({'alarms-storage': {'timer-1': {when: 1}}});
      alarms.create('timer-1', {when: Date.now() + 60000});
      storage.hold();
      setAlarm(chrome, 'alarm-y:0', Date.now() + 3600000);
      await sleep(150); // the debounced flush starts and blocks on its read
      alarms.fire('timer-1'); // fires while the create is still in flight
      await settle(storage);
      await sleep(200); // any follow-up debounced flush
      await settle(storage);
      const mirror = storage.mirror();
      ok(mirror['alarm-y:0'], 'the flushed create was dropped from the mirror');
      ok(!mirror['timer-1'], 'the fired one-shot survived in the mirror');
    }
  },
  {
    id: 2,
    name: '2. a fired one-shot cannot resurrect a just-cleared entry',
    run: async workerPath => {
      const {storage, alarms, chrome} = await loadWorker(workerPath);
      storage.seed({'alarms-storage': {'alarm-z:0': {when: 1}, 'timer-1': {when: 1}}});
      alarms.create('timer-1', {when: Date.now() + 60000});
      storage.hold();
      clearAlarm(chrome, 'alarm-z:0');
      await sleep(150); // flush #1 clears alarm-z:0 and blocks on its read
      runOldest(storage, 'get'); // let the flush read and post its write
      await sleep(5);
      alarms.fire('timer-1'); // fires while the clear is still in flight
      await settle(storage);
      await sleep(200);
      await settle(storage);
      const mirror = storage.mirror();
      ok(!mirror['alarm-z:0'], 'the cleared entry was resurrected in the mirror');
      ok(!mirror['timer-1'], 'the fired one-shot survived in the mirror');
    }
  },
  {
    id: 3,
    name: '3. two one-shots firing together both leave the mirror',
    run: async workerPath => {
      const {storage, alarms} = await loadWorker(workerPath);
      storage.seed({'alarms-storage': {'timer-1': {when: 1}, 'audio-alarm-x/1': {when: 1}}});
      alarms.create('timer-1', {when: Date.now() + 60000});
      alarms.create('audio-alarm-x/1', {when: Date.now() + 60000});
      storage.hold();
      alarms.fire('timer-1');
      alarms.fire('audio-alarm-x/1');
      await sleep(150);
      await settle(storage);
      await sleep(200);
      await settle(storage);
      const mirror = storage.mirror();
      ok(!mirror['timer-1'], 'timer-1 was resurrected by the second write');
      ok(!mirror['audio-alarm-x/1'], 'audio-alarm-x/1 was resurrected by the first write');
    }
  },
  {
    id: 4,
    name: '4. an overlapping flush waits for the in-flight write to land',
    run: async workerPath => {
      const {storage, chrome} = await loadWorker(workerPath);
      storage.hold();
      setAlarm(chrome, 'timer-10', Date.now() + 60000);
      await sleep(150); // flush #1 blocks on its read
      setAlarm(chrome, 'timer-11', Date.now() + 60000);
      runOldest(storage, 'get'); // flush #1 posts its write
      await sleep(5);
      ok(storage.pending().some(o => o.kind === 'set'), 'flush #1 did not post a write');
      await sleep(120); // flush #2's debounce elapses mid-write
      // serialization: flush #2 must not read until flush #1 has landed
      ok(storage.pending().every(o => o.kind !== 'get'),
        'flush #2 read a snapshot while flush #1 was still writing');
      await settle(storage);
      await sleep(200);
      await settle(storage);
      const mirror = storage.mirror();
      ok(mirror['timer-10'], 'flush #1 was dropped by flush #2');
      ok(mirror['timer-11'], 'flush #2 never landed');
    }
  },
  {
    id: 5,
    name: '5. "remove all" does not resurrect pending entries',
    run: async workerPath => {
      const {storage, alarms, chrome} = await loadWorker(workerPath);
      storage.hold();
      setAlarm(chrome, 'alarm-z:0', Date.now() + 3600000);
      removeAll(chrome); // clicked inside the create's debounce window
      await sleep(150); // the debounced flush starts
      await settle(storage);
      await sleep(200);
      await settle(storage);
      const mirror = storage.mirror();
      ok(!mirror['alarm-z:0'], 'a pending create was resurrected by the flush');
      ok(alarms.calls.includes('alarm-z:0') === false,
        'a browser alarm was re-created after the wipe');
    }
  },
  {
    id: 6,
    name: '6. a snoozed alarm fire cleans the slot and schedules snoozes',
    run: async workerPath => {
      const {storage, alarms} = await loadWorker(workerPath);
      storage.seed({
        'alarms': [{id: 'alarm-x', name: 'coffee', repeat: 'once', time: {hours: 6, minutes: 0}, snooze: true}],
        'alarms-storage': {'alarm-x:0': {when: 1}}
      });
      alarms.create('alarm-x:0', {when: Date.now() - 1000});
      alarms.fire('alarm-x:0');
      await sleep(300); // mirror cleanup plus the debounced snooze flush
      await settle(storage);
      const mirror = storage.mirror();
      ok(!mirror['alarm-x:0'], 'the fired slot survived in the mirror');
      ok(mirror['audio-alarm-x/1'], 'the first snooze was not scheduled');
      ok(mirror['audio-alarm-x/2'], 'the second snooze was not scheduled');
    }
  },
  {
    id: 7,
    name: '7. the popup re-renders only after the browser alarms settle',
    run: async workerPath => {
      const {storage, alarms, chrome} = await loadWorker(workerPath);
      // snapshot what the popup's storage.onChanged -> init() would
      // query at re-render time: the live chrome.alarms list
      const views = [];
      storage.onChanged.addListener(ps => {
        if (ps['alarms-storage']) {
          views.push([...alarms.map.keys()].sort());
        }
      });
      alarms.defer(); // chrome.alarms create/clear land only when released
      setAlarm(chrome, 'timer-2', Date.now() + 60000);
      await sleep(150); // the flush issues its create job and blocks
      // no mirror write may land while the job is in flight: the
      // popup would re-render and read the stale alarm list
      ok(views.length === 0, 'the popup re-rendered from a mirror write that landed mid-flight');
      alarms.settleJobs(); // the browser applies the alarm, jobs settle
      await sleep(50);
      ok(views.length === 1, 'expected exactly one popup re-render, got ' + views.length);
      ok(views[0].includes('timer-2'), 'the popup re-rendered without the new browser alarm');
    }
  },
  {
    id: 8,
    name: '8. a fired once-slot is recorded in the fired-slots log',
    run: async workerPath => {
      const {storage, alarms} = await loadWorker(workerPath);
      const when = Date.now() - 1000;
      storage.seed({
        'alarms': [{id: 'alarm-x', name: 'coffee', repeat: 'once', time: {hours: 6, minutes: 0}}],
        'alarms-storage': {'alarm-x:0': {when}}
      });
      alarms.create('alarm-x:0', {when});
      alarms.fire('alarm-x:0');
      await sleep(300); // the debounced mirror cleanup plus the log append
      await settle(storage);
      const mirror = storage.mirror();
      ok(!mirror['alarm-x:0'], 'the fired slot survived in the mirror');
      // the popup reads this log to tell a rung once-date from one that
      // never got scheduled (the alarm itself is already gone)
      const log = storage.read('fired-slots') || [];
      ok(log.length === 1, 'the fired slot was not recorded in the log');
      ok(log[0].id === 'alarm-x', 'the log entry has the wrong alarm id');
      ok(log[0].when === when, 'the log entry has the wrong epoch');
    }
  },
  {
    id: 9,
    name: '9. an import rebuilds the live set from the imported mirror',
    run: async workerPath => {
      const {storage, alarms, chrome} = await loadWorker(workerPath);
      const future = Date.now() + 3600000;
      // pre-import leftovers (a packed install keeps them across a reload)
      alarms.create('alarm-old:0', {when: future});
      alarms.create('timer-1', {when: future});
      alarms.create('audio-alarm-old/1', {when: future});
      // preferences written by the options page: a daily alarm whose
      // mirror slot is past due
      storage.seed({
        'alarms': [{id: 'alarm-new', name: 'coffee', repeat: 'daily', time: {hours: 7, minutes: 0}}],
        'alarms-storage': {'alarm-new:0': {when: Date.now() - 60000}},
        'missed-alarms': []
      });
      chrome.runtime.onMessage.fire({method: 'restore-alarms'}, {}, () => {});
      await sleep(300); // the restore pass plus the debounced flush
      await settle(storage);
      await sleep(200);
      await settle(storage);
      ok(alarms.map.has('alarm-new:0'), 'the imported slot was not rebuilt');
      ok(alarms.map.get('alarm-new:0').scheduledTime > Date.now(),
        'the past-due imported slot was rebuilt past-due instead of re-anchoring');
      ok(!alarms.map.has('alarm-old:0'), 'a pre-import alarm slot survived the import');
      ok(!alarms.map.has('timer-1'), 'the pre-import timer survived the import');
      ok(!alarms.map.has('audio-alarm-old/1'), 'a pre-import snooze survived the import');
      const mirror = storage.mirror();
      ok(mirror['alarm-new:0'], 'the imported entry was dropped from the mirror');
      ok(Object.keys(mirror).length === 1, 'the mirror is not exactly the imported survivors');
      ok((storage.read('missed-alarms') || []).length === 0,
        'a re-anchored recurring slot was reported as missed');
    }
  },
  {
    id: 10,
    name: '10. an import drops an expired once-slot and reports it as missed',
    run: async workerPath => {
      const {storage, alarms, chrome} = await loadWorker(workerPath);
      const past = Date.now() - 60000;
      storage.seed({
        'alarms': [{id: 'alarm-x', name: 'coffee', repeat: 'once', time: {hours: 6, minutes: 0}}],
        'alarms-storage': {'alarm-x:0': {when: past}}
      });
      chrome.runtime.onMessage.fire({method: 'restore-alarms'}, {}, () => {});
      await sleep(300); // the flush plus the missed append writer
      await settle(storage);
      ok(!alarms.map.has('alarm-x:0'), 'the expired once-slot was rebuilt and would ring');
      const mirror = storage.mirror();
      ok(!mirror['alarm-x:0'], 'the expired once-slot stayed in the mirror');
      const missed = storage.read('missed-alarms') || [];
      ok(missed.length === 1, 'the expired once-slot was not reported as missed');
      ok(missed[0].name === 'alarm-x:0' && missed[0].when === past,
        'the missed record has the wrong identity');
    }
  },
  {
    id: 11,
    name: '11. a reset clears the whole live set',
    run: async workerPath => {
      const {storage, alarms, chrome} = await loadWorker(workerPath);
      const future = Date.now() + 3600000;
      alarms.create('timer-1', {when: future});
      alarms.create('alarm-a:0', {when: future});
      alarms.create('audio-alarm-a/1', {when: future});
      // post-reset storage: mirror and definitions are empty
      storage.seed({
        'alarms': [],
        'alarms-storage': {}
      });
      chrome.runtime.onMessage.fire({method: 'restore-alarms'}, {}, () => {});
      await sleep(300);
      await settle(storage);
      ok(!alarms.map.has('timer-1'), 'the live timer survived the reset');
      ok(!alarms.map.has('alarm-a:0'), 'a live alarm slot survived the reset');
      ok(!alarms.map.has('audio-alarm-a/1'), 'a live snooze survived the reset');
      ok(Object.keys(storage.mirror() || {}).length === 0, 'the mirror was not empty after the reset');
    }
  },
  {
    id: 12,
    name: '12. the startup pass sweeps live orphans and runs once',
    run: async workerPath => {
      const {storage, alarms, chrome} = await loadWorker(workerPath);
      const future = Date.now() + 3600000;
      // live leftovers with no mirror behind them (what a pre-fix import
      // or reset leaves behind on a packed install)
      alarms.create('alarm-orphan:0', {when: future});
      alarms.create('audio-alarm-orphan/2', {when: future});
      storage.seed({
        'alarms': [],
        'alarms-storage': {'timer-9': {when: future}}
      });
      chrome.runtime.onStartup.fire();
      await sleep(300);
      await settle(storage);
      ok(!alarms.map.has('alarm-orphan:0'), 'an orphaned alarm slot survived the startup sweep');
      ok(!alarms.map.has('audio-alarm-orphan/2'), 'an orphaned snooze survived the startup sweep');
      const built = alarms.calls.filter(c => c === 'timer-9').length;
      ok(built === 1, 'the startup pass did not rebuild the mirror entry');
      // the guard makes a second startup pass a no-op
      chrome.runtime.onStartup.fire();
      await sleep(200);
      await settle(storage);
      ok(alarms.calls.filter(c => c === 'timer-9').length === built,
        'the guarded second pass re-ran the restore');
    }
  },
  {
    id: 13,
    name: '13. disabling an alarm sweeps its pending snoozes',
    run: async workerPath => {
      const {storage, alarms, chrome} = await loadWorker(workerPath);
      const future = Date.now() + 1800000;
      storage.seed({
        'alarms': [{id: 'alarm-x', name: 'coffee', repeat: 'once', time: {hours: 6, minutes: 0}, snooze: true}],
        'alarms-storage': {
          'alarm-x:0': {when: future},
          // 'audio-<id>/N' is the only shape in use today: both
          // producers name snoozes with the bare alarm id (the
          // worker's on-fire scheduling, and the window's Snooze
          // button composing from the notification's bare-id name)
          'audio-alarm-x/1': {when: future},
          'audio-alarm-x/2': {when: future},
          // slot-shaped snoozes are unreachable today; seeded to pin
          // the sweep's defensive ':' match
          'audio-alarm-x:0/6': {when: future}
        }
      });
      for (const [name, info] of Object.entries(storage.read('alarms-storage'))) {
        alarms.create(name, info);
      }
      // the popup's disable/delete batch: clear the slots of this id
      // (the snooze clears it sends land on the same cache; the sweep
      // below is what catches snoozes its stale snapshot missed)
      clearAlarm(chrome, 'alarm-x:0');
      await sleep(300); // the debounced flush
      await settle(storage);
      await sleep(200);
      await settle(storage);
      ok(!alarms.map.has('alarm-x:0'), 'the alarm slot survived the disable');
      ok(!alarms.map.has('audio-alarm-x/1') && !alarms.map.has('audio-alarm-x/2'),
        'a pending snooze survived the disable');
      ok(!alarms.map.has('audio-alarm-x:0/6'),
        'a slot-shaped snooze survived the disable');
      const mirror = storage.mirror();
      ok(!mirror['audio-alarm-x/1'] && !mirror['audio-alarm-x/2'] && !mirror['audio-alarm-x:0/6'],
        'a swept snooze survived in the mirror');
    }
  },
  {
    id: 14,
    name: '14. a prefix-colliding id keeps its snoozes',
    run: async workerPath => {
      const {storage, alarms, chrome} = await loadWorker(workerPath);
      const future = Date.now() + 1800000;
      storage.seed({
        'alarms': [
          {id: 'alarm-0.8', name: 'first', repeat: 'once', time: {hours: 6, minutes: 0}},
          {id: 'alarm-0.81', name: 'second', repeat: 'once', time: {hours: 7, minutes: 0}}
        ],
        'alarms-storage': {
          'alarm-0.8:0': {when: future},
          'alarm-0.81:0': {when: future},
          // both snooze shapes for each id; the ':'-shaped ones are
          // unreachable today (defensive coverage, see scenario 13)
          'audio-alarm-0.8/1': {when: future},
          'audio-alarm-0.8:0/3': {when: future},
          'audio-alarm-0.81/1': {when: future},
          'audio-alarm-0.81:0/2': {when: future}
        }
      });
      for (const [name, info] of Object.entries(storage.read('alarms-storage'))) {
        alarms.create(name, info);
      }
      // disabling 'alarm-0.8' must not sweep 'alarm-0.81's snoozes:
      // a bare-prefix match ('audio-' + key, no delimiter after the
      // id) would clear them too
      clearAlarm(chrome, 'alarm-0.8:0');
      await sleep(300);
      await settle(storage);
      await sleep(200);
      await settle(storage);
      ok(!alarms.map.has('alarm-0.8:0'), "alarm-0.8's slot survived the disable");
      ok(!alarms.map.has('audio-alarm-0.8/1') && !alarms.map.has('audio-alarm-0.8:0/3'),
        "alarm-0.8's own snoozes survived the disable");
      ok(alarms.map.has('alarm-0.81:0'), "alarm-0.81's slot was swept by the colliding id");
      ok(alarms.map.has('audio-alarm-0.81/1') && alarms.map.has('audio-alarm-0.81:0/2'),
        "alarm-0.81's snoozes were swept by the colliding id");
      const mirror = storage.mirror();
      ok(!mirror['audio-alarm-0.8/1'] && !mirror['audio-alarm-0.8:0/3'],
        "alarm-0.8's own snoozes survived in the mirror");
      ok(mirror['alarm-0.81:0'], "alarm-0.81's slot was dropped from the mirror");
      ok(mirror['audio-alarm-0.81/1'] && mirror['audio-alarm-0.81:0/2'],
        "alarm-0.81's snoozes were dropped from the mirror");
    }
  }
];

const main = async () => {
  const workerPath = path.resolve(process.argv[2] || path.join(root, 'worker.js'));
  if (fs.existsSync(workerPath) === false) {
    console.error('worker not found: ' + workerPath);
    process.exit(2);
  }
  // SCENARIOS=1,4 restricts the run, for debugging a single case
  const filter = (process.env.SCENARIOS || '')
    .split(',')
    .map(s => Number(s.trim()))
    .filter(n => n > 0);
  const selected = scenarios.filter(s => filter.length === 0 || filter.includes(s.id));
  let failed = 0;
  for (const s of selected) {
    try {
      await s.run(workerPath);
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
