#!/usr/bin/env node
'use strict';

/* Regression harness for the notification window's "bring to top on
 * blur" preference ('notify-on-top').
 *
 * The pref has three views that must agree: the notify window's
 * top-right checkbox (checked by default, persists on change), the
 * options-page checkbox, and the worker's bring-to-front gate that
 * focuses the sender's window on blur. The worker part loads
 * data/schedule.js plus worker.js into a vm with a stubbed chrome API
 * (the same approach as tests/race.test.js); the window part runs
 * data/notify/index.js against a minimal DOM stub and replays the
 * checkbox lifecycle: fresh install, uncheck, the next window opened
 * after the uncheck, and the storage.onChanged sync from the options
 * page.
 *
 * The in-page Audio constructor is left undefined on purpose: the load
 * block catches the failure and takes its fallback path, which is the
 * same route a real autoplay block takes.
 *
 * Scenarios 8-10 cover the create-time mis-size healing: the notify
 * window echoes the outer size it was created with, and the worker
 * re-asserts it through the position update whenever the reported
 * geometry disagrees (macOS double-scale, bugzilla 1554229; Linux/GTK
 * inner-size semantics, bugzilla 581863).
 *
 * Usage:
 *   node tests/notify.test.js
 *   SCENARIOS=2,5 node tests/notify.test.js   # restrict the run
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.resolve(__dirname, '..');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const ok = (cond, msg) => {
  if (!cond) {
    throw new Error(msg);
  }
};

// the query the worker composes for the notify window; every field the
// page reads must be present (args.get('name') is dereferenced bare)
// plus the intended outer size the window was created with
const SEARCH = '?name=alarm-1&title=Coffee&message=Ready&sound=sounds/1.mp3' +
  '&volume=0.8&repeats=2&snooze=false&position=center&w=580&h=250';

// listener hub shared by all stubbed chrome events
const hub = () => {
  const ls = [];
  return {
    addListener: l => ls.push(l),
    removeListener: () => {},
    fire: (...args) => ls.map(l => l(...args))
  };
};

// chrome.storage.local; synchronous callbacks, deep-cloned on every read
// and write like the real structured-clone boundary, fires onChanged on
// every write. A removal (what storage.local.clear() delivers) has to be
// fired through the hub directly.
const makeStorage = () => {
  const store = {};
  const onChanged = hub();
  const clone = o => JSON.parse(JSON.stringify(o));
  return {
    onChanged,
    seed(obj) {
      Object.assign(store, clone(obj));
    },
    read(key) {
      return clone(store[key]);
    },
    local: {
      get(defs, cb) {
        const out = clone(defs);
        for (const k of Object.keys(defs)) {
          if (k in store) {
            out[k] = clone(store[k]);
          }
        }
        if (cb) {
          cb(out);
        }
        return Promise.resolve(out);
      },
      set(obj, cb) {
        const changes = {};
        for (const [k, v] of Object.entries(obj)) {
          changes[k] = {newValue: clone(v)};
          store[k] = clone(v);
        }
        if (cb) {
          cb();
        }
        if (Object.keys(changes).length) {
          onChanged.fire(changes);
        }
        return Promise.resolve();
      }
    }
  };
};

// chrome.alarms; only the surface the worker touches without a fire
const makeAlarms = () => ({
  onAlarm: hub(),
  create: () => Promise.resolve(true),
  clear: () => Promise.resolve(false),
  get: (name, cb) => {
    if (cb) {
      cb(undefined);
    }
    return Promise.resolve(undefined);
  },
  getAll: cb => {
    if (cb) {
      cb([]);
    }
    return Promise.resolve([]);
  }
});

// tabs.update / windows.update land in the log; the blur gate and the
// position handler are the only callers a scenario can reach
const buildChrome = (storage, alarms, log) => ({
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
    update: (id, props) => {
      log.windows.push({id, props});
      return Promise.resolve();
    },
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
    update: (id, props) => {
      log.tabs.push({id, props});
      return Promise.resolve();
    },
    query: async () => [],
    create: () => Promise.resolve()
  },
  management: {getSelf: cb => cb && cb({installType: 'development'})}
});

// mirrors the Firefox background.scripts order: schedule.js defines its
// helpers in the same scope right before the worker runs
const loadWorker = async () => {
  const scheduleSrc = fs.readFileSync(path.join(root, 'data/schedule.js'), 'utf8');
  const workerSrc = fs.readFileSync(path.join(root, 'worker.js'), 'utf8');
  const storage = makeStorage();
  const log = {tabs: [], windows: []};
  const chrome = buildChrome(storage, makeAlarms(), log);
  const context = vm.createContext({
    chrome,
    console,
    setTimeout,
    clearTimeout,
    URLSearchParams,
    // webdriver:true skips the FAQ/uninstall block at load time
    navigator: {webdriver: true}
  });
  vm.runInContext(scheduleSrc + '\n;' + workerSrc, context, {filename: 'worker.js'});
  await sleep(30);
  return {storage, log, chrome};
};

// the blur message the notify window sends; the worker decides from
// the stored pref whether to honor it
const bringToFront = (chrome, tab = {id: 11, windowId: 22}) =>
  chrome.runtime.onMessage.fire({method: 'bring-to-front'}, {tab}, () => {});

// minimal DOM stub; only what data/notify/index.js touches at load
const makeElements = () => {
  const el = () => ({hidden: true, checked: false, selectedIndex: 0, value: ''});
  const byId = {};
  for (const id of ['sound-alert', 'snooze', 'range', 'clean', 'done', 'bring-to-front']) {
    byId[id] = el();
  }
  return {
    byId,
    bySelector: {'h1': el(), 'p': el(), 'img': el()}
  };
};

// runs the notify page in its own context over the given storage; the
// contexts are separate per load, like separate notification windows
const loadPage = async (storage, search = SEARCH) => {
  const src = fs.readFileSync(path.join(root, 'data/notify/index.js'), 'utf8');
  const {byId, bySelector} = makeElements();
  const sent = [];
  const win = {
    outerWidth: 580,
    outerHeight: 250,
    close() {},
    addEventListener() {}
  };
  const chrome = {
    runtime: {
      lastError: null,
      onMessage: hub(),
      sendMessage(m, cb) {
        sent.push(m);
        if (cb) {
          cb();
        }
      }
    },
    storage: {local: storage.local, onChanged: storage.onChanged}
  };
  const context = vm.createContext({
    chrome,
    window: win,
    location: {search},
    screen: {width: 1920, height: 1080},
    document: {
      querySelector: s => bySelector[s],
      getElementById: id => byId[id]
    },
    // muted: the deliberate Audio failure warns on every load
    console: {log() {}, warn() {}, error() {}, info() {}},
    setTimeout,
    clearTimeout,
    URLSearchParams
  });
  vm.runInContext(src, context, {filename: 'data/notify/index.js'});
  await sleep(30);
  return {byId, sent, win};
};

const scenarios = [
  {
    id: 1,
    name: '1. the bring-to-front gate is on for a fresh install',
    run: async () => {
      const {log, chrome} = await loadWorker();
      bringToFront(chrome);
      await sleep(50);
      ok(log.tabs.length === 1 && log.tabs[0].id === 11 &&
        log.tabs[0].props.highlighted === true,
        'the notification tab was not highlighted on blur');
      ok(log.windows.length === 1 && log.windows[0].id === 22 &&
        log.windows[0].props.focused === true,
        'the notification window was not focused on blur');
    }
  },
  {
    id: 2,
    name: '2. an unchecked pref keeps the window behind',
    run: async () => {
      const {storage, log, chrome} = await loadWorker();
      storage.seed({'notify-on-top': false});
      bringToFront(chrome);
      await sleep(50);
      ok(log.tabs.length === 0 && log.windows.length === 0,
        'the window was brought to front with the pref unchecked');
    }
  },
  {
    id: 3,
    name: '3. a pref change between blurs takes effect immediately',
    run: async () => {
      const {storage, log, chrome} = await loadWorker();
      storage.seed({'notify-on-top': false});
      bringToFront(chrome);
      await sleep(50);
      ok(log.windows.length === 0, 'the window was focused while unchecked');
      // the notify window's checkbox writes the pref; the gate re-reads
      // it on every blur
      storage.local.set({'notify-on-top': true});
      bringToFront(chrome);
      await sleep(50);
      ok(log.windows.length === 1 && log.windows[0].props.focused === true,
        'the window was not focused after re-checking');
    }
  },
  {
    id: 4,
    name: '4. the window checkbox is checked by default',
    run: async () => {
      const storage = makeStorage();
      const page = await loadPage(storage);
      ok(page.byId['bring-to-front'].checked === true,
        'the checkbox is not checked on a fresh install');
      // the HTML must ship the same default so the box is never flashed
      // in the wrong state before the storage read lands
      const html = fs.readFileSync(path.join(root, 'data/notify/index.html'), 'utf8');
      ok(/<input type="checkbox" id="bring-to-front" checked>/.test(html),
        'index.html lost the checked default attribute');
    }
  },
  {
    id: 5,
    name: '5. unchecking persists and the next window remembers it',
    run: async () => {
      const storage = makeStorage();
      const page = await loadPage(storage);
      const box = page.byId['bring-to-front'];
      box.checked = false;
      box.onchange({target: box});
      ok(storage.read('notify-on-top') === false,
        'unchecking did not persist the pref');
      // blur still reports to the worker (the gate decides there);
      // scenario 2 pins that an unchecked pref is ignored
      page.win.onblur();
      await sleep(150);
      ok(page.sent.some(m => m.method === 'bring-to-front'),
        'the window stopped reporting blur');
      // a fresh notification window opened after the uncheck
      const next = await loadPage(storage);
      ok(next.byId['bring-to-front'].checked === false,
        'the next notification window did not remember the uncheck');
    }
  },
  {
    id: 6,
    name: '6. the checkbox follows a change made on the options page',
    run: async () => {
      const storage = makeStorage();
      storage.seed({'notify-on-top': false});
      const page = await loadPage(storage);
      ok(page.byId['bring-to-front'].checked === false,
        'the seeded pref was ignored');
      // the options page's Save writes the pref while this window rings
      storage.local.set({'notify-on-top': true});
      ok(page.byId['bring-to-front'].checked === true,
        'the checkbox did not follow the options-page change');
    }
  },
  {
    id: 7,
    name: '7. a cleared pref (reset/import) falls back to checked',
    run: async () => {
      const storage = makeStorage();
      storage.seed({'notify-on-top': false});
      const page = await loadPage(storage);
      ok(page.byId['bring-to-front'].checked === false,
        'the seeded pref was ignored');
      // what chrome.storage.local.clear() delivers: oldValue only
      storage.onChanged.fire({'notify-on-top': {oldValue: false}});
      ok(page.byId['bring-to-front'].checked === true,
        'a cleared pref did not fall back to the checked default');
    }
  },
  {
    id: 8,
    name: '8. the notify window reports its intended size for healing',
    run: async () => {
      const storage = makeStorage();
      const page = await loadPage(storage);
      const m = page.sent.find(x => x.method === 'position');
      ok(m, 'the notify window did not report its position');
      ok(m.size && m.size.width === 580 && m.size.height === 250,
        'the position message does not carry the intended size');
      ok(m.window.width === 580 && m.window.height === 250,
        'the position message lost the window geometry report');
      // the intended size comes from the query the worker created the
      // window with; a stale/foreign query falls back to the geometry
      const stale = await loadPage(makeStorage(), '?name=a&position=tr');
      const s = stale.sent.find(x => x.method === 'position').size;
      ok(s.width === 580 && s.height === 250,
        'a query without the size fell back to the window geometry');
    }
  },
  {
    id: 9,
    name: '9. an oversized report is healed by a size-carrying update',
    run: async () => {
      const {log, chrome} = await loadWorker();
      // what macOS reports right after create on a mixed-DPI setup: the
      // double-scaled geometry of bugzilla 1554229
      chrome.runtime.onMessage.fire({
        method: 'position',
        screen: {width: 1920, height: 1080},
        window: {width: 1160, height: 500},
        size: {width: 580, height: 250},
        position: 'center'
      }, {tab: {id: 11, windowId: 22}}, () => {});
      await sleep(50);
      ok(log.windows.length === 1, 'the position message was dropped');
      const p = log.windows[0].props;
      ok(p.width === 580 && p.height === 250,
        'the double-scaled window was not resized back to the intended size');
      ok(p.left === 670 && p.top === 415,
        'the placement did not use the intended size');
    }
  },
  {
    id: 10,
    name: '10. a matching report is placed without a size override',
    run: async () => {
      const {log, chrome} = await loadWorker();
      // Chrome (or a healed Firefox window, after its resize re-report):
      // the reported geometry already is the intended one
      chrome.runtime.onMessage.fire({
        method: 'position',
        screen: {width: 1920, height: 1080},
        window: {width: 580, height: 250},
        size: {width: 580, height: 250},
        position: 'br'
      }, {tab: {id: 11, windowId: 22}}, () => {});
      await sleep(50);
      ok(log.windows.length === 1, 'the position message was dropped');
      const p = log.windows[0].props;
      ok(p.width === undefined && p.height === undefined,
        'a matching report must not carry a size override');
      ok(p.left === 1340 && p.top === 830,
        'the bottom-right placement drifted');
    }
  }
];

const main = async () => {
  // SCENARIOS=2,5 restricts the run, for debugging a single case
  const filter = (process.env.SCENARIOS || '')
    .split(',')
    .map(s => Number(s.trim()))
    .filter(n => n > 0);
  const selected = scenarios.filter(s => filter.length === 0 || filter.includes(s.id));
  let failed = 0;
  for (const s of selected) {
    try {
      await s.run();
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
