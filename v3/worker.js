'use strict';

if (typeof importScripts === 'function') {
  importScripts('data/schedule.js');
}

const BADGE_TICK = 'badge-tick'; // helper alarm that refreshes the toolbar badge

const notifications = {
  clear(name, c) {
    chrome.runtime.sendMessage({
      method: 'remove-notification',
      name
    }, () => {
      chrome.runtime.lastError;
      c();
    });
  },
  async create(name, opts) {
    const args = new URLSearchParams();
    args.set('name', name);
    args.set('title', opts.title);
    args.set('message', opts.message);
    args.set('sound', opts.sound);
    args.set('volume', opts.volume);
    args.set('repeats', opts.repeats);
    args.set('snooze', opts.snooze);

    const prefs = await chrome.storage.local.get({
      'notify-position': 'center' // center, br, tr
    });
    args.set('position', prefs['notify-position']);

    const p = {
      width: 580,
      height: 250,
      type: 'popup',
      url: 'data/notify/index.html?' + args.toString()
    };
    // the intended outer size travels to the page: its first geometry
    // report may disagree (macOS opens freshly created popup windows
    // double-scaled on mixed-DPI screens - bugzilla 1554229; Linux/GTK
    // applies the create size to the content area - bugzilla 581863),
    // and the page echoes this back so the position handler can heal it
    args.set('w', p.width);
    args.set('h', p.height);
    chrome.windows.create(p);
  },
  kill() {
    chrome.runtime.sendMessage({
      method: 'remove-all-notifications'
    }, () => chrome.runtime.lastError);
  }
};

// offscreen document fallback for alarm sounds; used when the visible
// notification window cannot play audio because the browser blocks
// audible autoplay (alarms fire without a user gesture)
const offscreen = {
  creating: null,
  async setup() {
    const url = 'data/offscreen/index.html';
    const path = chrome.runtime.getURL(url);
    if ('getContexts' in chrome.runtime) {
      const contexts = await chrome.runtime.getContexts({
        contextTypes: ['OFFSCREEN_DOCUMENT'],
        documentUrls: [path]
      });
      if (contexts.length) {
        return;
      }
    }
    offscreen.creating = chrome.offscreen.createDocument({
      url,
      reasons: ['AUDIO_PLAYBACK'],
      justification: 'Play the alarm/timer notification sound when in-page playback is blocked by the browser autoplay policy'
    });
    try {
      await offscreen.creating;
    }
    finally {
      offscreen.creating = null;
    }
  },
  async play({src, volume, repeats}) {
    if (('offscreen' in chrome) === false) {
      console.warn('offscreen API is not available');
      return false;
    }
    try {
      await offscreen.setup();
    }
    catch (e) {
      console.warn('failed to create offscreen document', e);
      return false;
    }
    return new Promise(resolve => {
      chrome.runtime.sendMessage({
        target: 'offscreen',
        method: 'play-audio',
        src,
        volume,
        repeats
      }, ok => {
        const err = chrome.runtime.lastError;
        if (err) {
          console.warn('offscreen playback error', err.message);
          resolve(false);
        }
        else {
          resolve(ok === true);
        }
      });
    });
  },
  stop() {
    if ('offscreen' in chrome) {
      chrome.offscreen.closeDocument().catch(() => {});
    }
  }
};

// silent "missed while the browser was closed" summary; opened once per
// restore pass that found newly missed entries (browser start, install
// or import; the page lists every undismissed record, not just the
// fresh ones)
const missed = {
  open() {
    chrome.storage.local.get({
      'notify-position': 'center' // center, br, tr
    }, prefs => {
      const args = new URLSearchParams();
      args.set('position', prefs['notify-position']);
      // same size echo as notifications.create: the missed window heals
      // the same create-time mis-size through its position report
      args.set('w', 420);
      args.set('h', 400);
      chrome.windows.create({
        width: 420,
        height: 400,
        type: 'popup',
        url: 'data/missed/index.html?' + args.toString()
      });
    });
  }
};

// display label for an expired slot; null means "do not report" (stray
// slot of a removed alarm definition, or an unrecognized name) - those
// are dropped from the mirror exactly like before, just not listed
const missedTitle = (defs, name) => {
  if (name.startsWith('audio-')) {
    const id = name.slice('audio-'.length).split('/')[0];
    if (id.startsWith('timer-')) {
      return 'Snoozed Timer';
    }
    const label = defs.has(id) ? schedule.normalize(defs.get(id)).name : '';
    return label ? 'Snoozed Alarm: ' + label : 'Snoozed Alarm';
  }
  if (name.startsWith('timer-')) {
    return 'Timer';
  }
  if (name.startsWith('alarm-')) {
    const def = defs.get(name.split(':')[0]);
    return def ? (schedule.normalize(def).name || 'Alarm') : null;
  }
  return null;
};

// rebuilds alarms-storage entries: recurring slots are re-anchored to
// wall-clock times (fixed-period repeats drift across DST changes) and
// expired entries are dropped. one-shot ("once") slots keep their exact
// toggle-time epoch and simply expire when due - rebuilding them would
// resurrect already-fired occurrences as endless repeats. expired
// non-periodic entries (once-slots, timers, snoozes) are appended to
// "missed" so the user can review what came due while the browser was
// closed instead of it vanishing silently
const normalizeStorage = (defs, storage, missed = [], from = Date.now()) => {
  let changed = false;
  let fresh = 0; // missed records appended by this pass
  const ids = new Set(
    Object.keys(storage)
      .filter(n => n.startsWith('alarm-'))
      .map(n => n.split(':')[0])
      .filter(id => defs.has(id))
  );
  for (const id of ids) {
    const def = schedule.normalize(defs.get(id));
    if (def.repeat === 'once') {
      continue;
    }
    const slots = schedule.slots(def, from);
    Object.keys(storage)
      .filter(n => n.startsWith(id + ':'))
      .forEach((n, index) => {
        if (index < slots.length) {
          storage[n] = {...slots[index]};
        }
        else {
          delete storage[n];
        }
        changed = true;
      });
  }
  for (const [name, info] of Object.entries(storage)) {
    // storage is an untrusted boundary (imported preferences): a mirror
    // entry without a usable shape can neither be scheduled nor expire -
    // drop it and let the restore flush rebuild the mirror from the
    // survivors (a null here used to kill the whole pass)
    if (info === null || typeof info !== 'object' ||
      Number.isFinite(info.when) === false ||
      (info.periodInMinutes !== undefined && Number.isFinite(info.periodInMinutes) === false)) {
      delete storage[name];
      changed = true;
    }
    else if (info.when < from) {
      if (info.periodInMinutes) {
        while (info.when < from) {
          info.when += info.periodInMinutes * 60 * 1000;
        }
      }
      else {
        const title = missedTitle(defs, name);
        if (title && missed.some(m => m.name === name && m.when === info.when) === false) {
          missed.push({
            name,
            title,
            when: info.when, // epoch the slot was due
            found: from // epoch this miss was detected
          });
          fresh += 1;
        }
        delete storage[name];
      }
      changed = true;
    }
  }
  if (fresh) {
    missed.sort((a, b) => a.when - b.when);
  }
  return {changed, fresh};
};

const alarms = {
  async fire({name}) {
    const set = (name, title, sound, repeats, volume, message = `Time's up`, snooze = false) => notifications.clear(name, () => {
      notifications.create(name, {
        title,
        message: message + '\n\n' + (new Date()).toLocaleString(),
        sound,
        volume,
        repeats,
        snooze
      });
    });
    if (name.startsWith('timer-')) {
      const prefs = await chrome.storage.local.get({
        'src-timer': 'data/sounds/4.mp3',
        'repeats-timer': 5,
        'volume-timer': 0.8
      });
      set(name, 'Timer', prefs['src-timer'], prefs['repeats-timer'], prefs['volume-timer']);
    }
    else if (name.startsWith('alarm-')) {
      const id = name.split(':')[0];
      const prefs = await chrome.storage.local.get({
        'alarms': [],
        'src-alarm': 'data/sounds/1.mp3',
        'repeats-alarm': 5, // number of times sound loops with "alarm" sound
        'volume-alarm': 0.8
      });
      // storage is an untrusted boundary (imported preferences)
      const raw = (Array.isArray(prefs.alarms) ? prefs.alarms : [])
        .filter(a => a?.id === id).shift();
      const o = raw ? schedule.normalize(raw) : null;
      if (o?.snooze) {
        alarms.create('audio-' + id + '/1', {
          when: Date.now() + 5 * 60 * 1000
        });
        alarms.create('audio-' + id + '/2', {
          when: Date.now() + 10 * 60 * 1000
        });
      }
      set(id, 'Alarm', prefs['src-alarm'], prefs['repeats-alarm'], prefs['volume-alarm'], o?.name, o?.snooze);
      // reschedule upcoming occurrences of recurring alarms from their
      // wall-clock definition; once-alarms must stay one-shot (their
      // remaining slots are already scheduled and drift-free). stale slot
      // names beyond the new count get swept by the clear step
      if (o && o.repeat !== 'once') {
        schedule.slots(o).forEach((info, index) => alarms.create(id + ':' + index, info));
      }
    }
    else if (name.startsWith('audio-')) {
      const id = name.replace('audio-', '').split('/')[0];
      const prefs = await chrome.storage.local.get({
        'alarms': [],
        'src-misc': 'data/sounds/5.mp3',
        'repeats-misc': 5, // number of times sound loops with "misc" sound
        'volume-misc': 0.8
      });
      let title = 'Misc';
      if (id.startsWith('alarm-')) {
        title = 'Alarm Snoozed';
      }
      else if (id.startsWith('timer-')) {
        title = 'Timer Snoozed';
      }
      const o = (Array.isArray(prefs.alarms) ? prefs.alarms : [])
        .filter(a => a?.id === id).shift();
      set(id, title, prefs['src-misc'], prefs['repeats-misc'], prefs['volume-misc'], o?.name);
    }
  },
  get(name, c) {
    chrome.alarms.get(name, c);
  },
  getAll(c = () => {}) {
    return new Promise(resolve => chrome.alarms.getAll(as => {
      const os = as.filter(a => a.name !== BADGE_TICK);
      resolve(os);
      c(os);
    }));
  }
};

// create or clear
{
  // pending 'alarms-storage' changes, applied by the debounced flush
  // below; create always wins over a pending clear/remove of the same
  // name
  const cache = {
    create: new Map(),
    clear: new Set(),
    // mirror-only deletions for fired one-shot slots: the browser
    // drops a fired alarm on its own, so unlike cache.clear these must
    // not call chrome.alarms nor sweep sibling slots of the same id
    remove: new Set(),
    // reset the whole mirror on the next flush ("remove all")
    wipe: false
  };
  // 'alarms-storage' has a single writer: every flush is queued here
  // and only counts as done after its write landed, so two
  // read-modify-write cycles can never interleave and silently drop
  // each other's entries (debouncing alone does not guarantee that -
  // a flush can still be writing while the next one reads a snapshot
  // that predates its write)
  const writers = [];
  let writing = false;
  const serialize = writer => {
    writers.push(writer);
    if (writing) {
      return;
    }
    writing = true;
    (async () => {
      while (writers.length) {
        try {
          await writers.shift()();
        }
        catch (e) {
          console.warn('alarms-storage writer failed', e);
        }
      }
      writing = false;
    })();
  };

  const flush = () => serialize(async () => {
    const as = await alarms.getAll();
    const prefs = await chrome.storage.local.get({
      'alarms-storage': {}
    });
    if (cache.wipe) {
      cache.wipe = false;
      prefs['alarms-storage'] = {};
      // "remove all": clear every live browser alarm in this same
      // flush, from this flush's own snapshot (a getAll in the caller
      // can predate a queued flush's creates), so the clears settle
      // before the mirror write lands instead of racing the popup's
      // re-render
      for (const a of as) {
        cache.clear.add(a.name);
      }
    }
    // clear old alarms
    const keys = [
      ...cache.clear.keys(),
      ...cache.create.keys()
    ].map(s => s.split(':')[0]);

    // slot names are '<id>:<index>', so require the ':' delimiter to
    // avoid sweeping prefix-colliding ids ('alarm-0.8' vs 'alarm-0.81');
    // colon-less names (timer-1, snoozes) must equal their key exactly.
    // a key's pending snoozes join the same sweep, so disabling or
    // deleting an alarm (or resetting its timer) cannot leave a snooze
    // ringing behind it. 'audio-<id>/N' is the only shape in use (both
    // producers - the on-fire scheduling and the notification window's
    // Snooze button - name snoozes with the bare id); the ':' snooze
    // alternative is defensive. should naming ever switch to fired
    // slots, the slot must also be stripped where the name is resolved
    // back to a definition: fire()'s def lookup, missedTitle's
    // defs.has and the popup toast's defs.get
    for (const a of as.filter(a => keys.some(key => a.name === key ||
      a.name.startsWith(key + ':') ||
      a.name.startsWith('audio-' + key + '/') ||
      a.name.startsWith('audio-' + key + ':')))) {
      cache.clear.add(a.name);
    }

    const jobs = [];
    // clear alarms
    for (const name of cache.clear) {
      if (cache.create.has(name) === false) {
        jobs.push(chrome.alarms.clear(name));
        delete prefs['alarms-storage'][name];
      }
    }
    cache.clear.clear();
    // drop storage mirrors of fired one-shot slots
    for (const name of cache.remove) {
      if (cache.create.has(name) === false) {
        delete prefs['alarms-storage'][name];
      }
    }
    cache.remove.clear();
    // set new alarms
    for (const [name, info] of cache.create) {
      jobs.push(chrome.alarms.create(name, info));
      prefs['alarms-storage'][name] = info;
    }
    cache.create.clear();
    // browser alarms settle BEFORE the mirror write lands: the popup
    // re-renders on the storage.onChanged event and queries
    // chrome.alarms (entry.update derives its scheduled state from
    // that list), so a write landing while the jobs are in flight
    // renders stale toggle state
    await Promise.allSettled(jobs);
    // completes only after the write landed, so a queued flush re-reads
    // the updated mirror instead of a snapshot that predates this write
    await chrome.storage.local.set(prefs);
    // the badge reads the settled browser state; it is not part of the
    // mirror write and must not block the writer queue
    (async () => {
      await badge.update();
    })();
  });

  const step = () => {
    clearTimeout(step.id);
    step.id = setTimeout(flush, 100);
  };

  alarms.create = (name, info) => {
    cache.create.set(name, info);
    cache.clear.delete(name);
    cache.remove.delete(name);
    step();
  };
  alarms.clear = (name, callback = () => {}) => {
    cache.clear.add(name);
    cache.create.delete(name);
    cache.remove.delete(name);
    callback();
    step();
  };

  // remove every scheduled alarm/timer: entries pending in the cache
  // predate the wipe and must not resurrect anything, while entries
  // queued after this call land on top of the fresh mirror. the flush
  // consuming the wipe also clears every live browser alarm from its
  // own snapshot, so nothing is left orphaned in chrome.alarms
  alarms.removeAll = () => {
    cache.create.clear();
    cache.clear.clear();
    cache.remove.clear();
    cache.wipe = true;
    step();
  };

  // full reconcile of the live alarm set from the stored mirror: used by
  // the startup/install pass and by the options page after a preference
  // import or reset ('restore-alarms' message). the reload those used to
  // perform fires neither onInstalled nor onStartup, and a packed install
  // keeps its pre-import live alarms across it, so without this pass the
  // imported mirror would stay dead until the next browser start while
  // the stale live set keeps ringing
  alarms.restore = async () => {
    const prefs = await chrome.storage.local.get({
      'alarms-storage': {},
      'alarms': [],
      'missed-alarms': []
    });
    // storage is an untrusted boundary (imported preferences): repair the
    // shapes in place so the passes below cannot throw
    const defs = new Map((Array.isArray(prefs.alarms) ? prefs.alarms : []).map(a => [a?.id, a]));
    const storage = (prefs['alarms-storage'] && typeof prefs['alarms-storage'] === 'object' &&
      Array.isArray(prefs['alarms-storage']) === false) ? prefs['alarms-storage'] : {};
    // storage is an untrusted boundary (imported preferences): records are
    // objects the page can render; junk elements ride along only until the
    // next missed append writes the cleaned list back
    prefs['missed-alarms'] = (Array.isArray(prefs['missed-alarms']) ? prefs['missed-alarms'] : [])
      .filter(m => m && typeof m === 'object');
    const {fresh} = normalizeStorage(defs, storage, prefs['missed-alarms']);
    const entries = Object.entries(storage);

    // the normalized mirror is the whole truth: wipe the live set and
    // rebuild from the survivors in a single debounced flush. unlike
    // alarms.removeAll this keeps cache entries pending from an alarm
    // firing alongside the pass (the snoozes of an alarm that just rang
    // at browser start must survive the rebuild); import and reset
    // cannot carry such entries, their message arrives from a page flow.
    // the flush clears every live alarm from its own snapshot
    // (BADGE_TICK excluded by alarms.getAll), the creates settle BEFORE
    // the mirror write lands, and entries normalizeStorage dropped never
    // come back
    cache.wipe = true;
    for (const [name, info] of entries) {
      alarms.create(name, info);
    }
    // an empty mirror (import or reset) must still flush the wipe: the
    // creates above are what schedule the debounced flush
    step();

    // expired one-shot/timer/snooze entries normalizeStorage collected
    // (dropped above) are reported as missed: append inside the single
    // writer queue, deduped by the same (name, when) identity, and open
    // the window only after the write landed so it reads the fresh list
    if (fresh) {
      serialize(async () => {
        const p = await chrome.storage.local.get({
          'missed-alarms': []
        });
        // storage is an untrusted boundary (imported preferences)
        const list = (Array.isArray(p['missed-alarms']) ? p['missed-alarms'] : [])
          .filter(m => m && typeof m === 'object');
        const add = prefs['missed-alarms'].filter(m =>
          list.some(x => x.name === m.name && x.when === m.when) === false);
        if (add.length) {
          p['missed-alarms'] = list.concat(add).sort((a, b) => a.when - b.when);
          await chrome.storage.local.set(p);
        }
        missed.open();
      });
    }
    badge.update();
  };

  alarms.fire = new Proxy(alarms.fire, {
    apply(target, self, args) {
      const o = args[0];
      if (!o.periodInMinutes) {
        // the browser drops a fired one-shot alarm by itself, so only
        // its storage mirror needs cleanup. enqueue it on the same
        // cache instead of running a second read-modify-write cycle on
        // 'alarms-storage' that could interleave with an in-flight
        // flush and drop its entries (or be dropped by it)
        cache.remove.add(o.name);
        step();
        // remember that a fired alarm slot actually rang: the browser has
        // already dropped it, so this log is the only way for the popup to
        // tell a rung once-date from one that never got scheduled (dropped
        // at toggle time, or missed while the browser was closed). it joins
        // the same serialized writer queue and never touches
        // 'alarms-storage'; snoozes ('audio-') and timers are not slots
        if (o.name.startsWith('alarm-') && o.name.includes(':')) {
          serialize(async () => {
            const prefs = await chrome.storage.local.get({
              'fired-slots': []
            });
            // storage is an untrusted boundary (imported preferences)
            const list = Array.isArray(prefs['fired-slots']) ? prefs['fired-slots'] : [];
            list.push({
              id: o.name.split(':')[0],
              when: o.scheduledTime // epoch the slot was due
            });
            // bounded: only the newest records are ever compared against
            // the live date chips of current definitions
            prefs['fired-slots'] = list.slice(-200);
            await chrome.storage.local.set(prefs);
          });
        }
      }

      return Reflect.apply(target, self, args);
    }
  });
}
{
  // startup/install pass: alarms.restore rebuilds the live set from the
  // mirror. the guard only covers these triggers - a 'restore-alarms'
  // message must still run in a worker instance that already did a pass
  // (an import can happen long after the browser started)
  const once = () => {
    if (once.done) {
      return;
    }
    once.done = true;
    alarms.restore();
  };
  chrome.runtime.onStartup.addListener(once);
  chrome.runtime.onInstalled.addListener(once);
}

/* toolbar badge: whole minutes left on the running timer */
const BADGE_COLOR = '#1a73e8'; // blue of the Chrome logo centre
const badge = {
  async paint() {
    const prefs = await chrome.storage.local.get({'badge-color': BADGE_COLOR});
    const color = /^#[0-9a-f]{6}$/i.test(prefs['badge-color']) ? prefs['badge-color'] : BADGE_COLOR;
    // black digits on light backgrounds, white on dark ones
    const [r, g, b] = [1, 3, 5].map(i => parseInt(color.substr(i, 2), 16));
    const light = 0.299 * r + 0.587 * g + 0.114 * b > 160;
    chrome.action.setBadgeBackgroundColor({color});
    chrome.action.setBadgeTextColor?.({color: light ? '#000000' : '#ffffff'});
  },
  async update() {
    clearTimeout(badge.id);
    const [a, prefs] = await Promise.all([
      chrome.alarms.get('timer-1'),
      chrome.storage.local.get({'badge-enabled': true})
    ]);
    const left = a && prefs['badge-enabled'] ? a.scheduledTime - Date.now() : 0;

    if (left <= 0) {
      chrome.action.setBadgeText({text: ''});
      chrome.alarms.clear(BADGE_TICK);
      return;
    }
    // 25:41 -> "25m"; 90:00 -> "1h"; ceil counts the minute in progress,
    // so a fresh 5m timer badges "5m" and the whole last minute stays "1m"
    const minutes = Math.ceil(left / 60000);
    const text = minutes < 100 ? minutes + 'm' : Math.floor(minutes / 60) + 'h';
    await badge.paint();
    chrome.action.setBadgeText({text});

    if (left <= 60000) { // already "1" until the end; firing timer-1 clears it
      chrome.alarms.clear(BADGE_TICK);
      return;
    }
    // wake up right after the next minute boundary
    const delay = left % 60000 + 250;
    chrome.alarms.create(BADGE_TICK, {when: Date.now() + delay});
    // chrome may postpone alarms closer than 30s; the worker is still alive, so cover it
    if (delay < 30000) {
      badge.id = setTimeout(badge.update, delay);
    }
  }
};

chrome.storage.onChanged.addListener(ps => {
  if (ps['badge-enabled']) {
    badge.update();
  }
  else if (ps['badge-color']) {
    badge.paint();
  }
});

chrome.alarms.onAlarm.addListener(a => {
  if (a.name === BADGE_TICK) {
    return badge.update();
  }
  alarms.fire(a);
  if (a.name.startsWith('timer-')) {
    badge.update();
  }
});

/* handling outdated alarms */
chrome.idle.onStateChanged.addListener(state => {
  if (state === 'active') {
    const now = Date.now();
    Promise.all([
      chrome.alarms.getAll(),
      chrome.storage.local.get({'alarms': []})
    ]).then(([os, prefs]) => {
      // storage is an untrusted boundary (imported preferences)
      const defs = new Map((Array.isArray(prefs.alarms) ? prefs.alarms : []).map(a => [a?.id, a]));
      for (const o of os.filter(o => o.name !== BADGE_TICK)) {
        if (o.scheduledTime < now) {
          const raw = o.name.startsWith('alarm-') ? defs.get(o.name.split(':')[0]) : null;
          const def = raw ? schedule.normalize(raw) : null;
          let info;
          if (def && def.repeat !== 'once') {
            // each slot re-anchors to its own next occurrence from the
            // wall-clock definition (weekly slots map by index; daily,
            // monthly and yearly have a single rescheduled slot)
            const slots = schedule.slots(def, now);
            info = {...(slots[Number(o.name.split(':')[1])] || slots[0])};
          }
          else {
            // once-alarms ring immediately (once) and expire; timers keep
            // their original period
            info = {
              when: now + 1000,
              periodInMinutes: o.periodInMinutes
            };
          }
          alarms.create(o.name, info);
        }
      }
    });
  }
});

const onMessage = (request, sender, respose) => {
  if (request.target === 'offscreen') {
    return;
  }

  if (request.method === 'set-alarm') {
    alarms.create(request.name, request.info);
  }
  else if (request.method === 'get-alarm') {
    alarms.get(request.name, respose);
    return true;
  }
  else if (request.method === 'get-alarms') {
    alarms.getAll(respose);
    return true;
  }
  else if (request.method === 'clear-alarm') {
    alarms.clear(request.name);
  }
  else if (request.method === 'clear-snoozes') {
    alarms.getAll(as => {
      for (const a of as.filter(a => a.name.startsWith('audio-' + request.name + '/'))) {
        alarms.clear(a.name);
      }
    });
  }
  else if (request.method === 'batch') {
    for (const job of request.jobs) {
      if (job.method === 'clear-alarm') {
        alarms.clear(job.name);
      }
      else if (job.method === 'set-alarm') {
        alarms.create(job.name, job.info);
      }
    }
  }
  else if (request.method === 'restore-alarms') {
    // sent by the options page after an import or reset
    alarms.restore().catch(e => console.warn('restore failed', e));
  }
  else if (request.method === 'remove-all-notifications') {
    notifications.kill();
  }
  else if (request.method === 'play-offscreen') {
    offscreen.play(request).then(ok => respose(ok), e => {
      console.warn('play-offscreen failed', e);
      respose(false);
    });
    return true;
  }
  else if (request.method === 'stop-offscreen-audio') {
    offscreen.stop();
  }
  else if (request.method === 'bring-to-front') {
    // checked by default: the notify window's own checkbox and the options
    // page share this pref, so unchecking it in either place persists
    chrome.storage.local.get({
      'notify-on-top': true
    }, prefs => {
      if (prefs['notify-on-top']) {
        chrome.tabs.update(sender.tab.id, {
          highlighted: true
        });
        chrome.windows.update(sender.tab.windowId, {
          focused: true
        });
      }
    });
  }
  else if (request.method === 'position') {
    // intended outer size of this window (echoed back from the query it
    // was created with): when the reported geometry disagrees - macOS
    // opens freshly created popup windows double-scaled on mixed-DPI
    // screens (bugzilla 1554229), Linux/GTK applies the create size to
    // the content area (bugzilla 581863) - the size is re-asserted in
    // the same update that places the window; a post-open resize heals
    // both. Chrome reports the intended size and gets placement only
    const w = Number(request.size?.width) || request.window.width;
    const h = Number(request.size?.height) || request.window.height;
    const size = (request.window.width !== w || request.window.height !== h) ?
      {width: w, height: h} : {};
    if (request.position === 'center') {
      chrome.windows.update(sender.tab.windowId, {
        ...size,
        left: parseInt((request.screen.width - w) / 2),
        top: parseInt((request.screen.height - h) / 2)
      });
    }
    else if (request.position === 'br') {
      chrome.windows.update(sender.tab.windowId, {
        ...size,
        left: parseInt(request.screen.width - w),
        top: parseInt(request.screen.height - h)
      });
    }
    else if (request.position === 'tr') {
      chrome.windows.update(sender.tab.windowId, {
        ...size,
        left: parseInt(request.screen.width - w),
        top: 0
      });
    }
  }
};
chrome.runtime.onMessage.addListener(onMessage);

const onCommand = async command => {
  if (command === 'open-interface') {
    const win = await chrome.windows.getCurrent();
    const prefs = await chrome.storage.local.get({
      width: 400,
      height: 600,
      left: win.left + Math.round((win.width - 400) / 2),
      top: win.top + Math.round((win.height - 600) / 2)
    });
    chrome.windows.create({
      url: 'data/popup/index.html?mode=pp',
      width: prefs.width,
      height: prefs.height,
      left: prefs.left,
      top: prefs.top,
      type: 'popup'
    });
  }
};
chrome.commands.onCommand.addListener(onCommand);
chrome.action.onClicked.addListener(() => onCommand('open-interface'));

chrome.storage.onChanged.addListener(ps => {
  if (ps.mode) {
    chrome.action.setPopup({
      popup: ps.mode.newValue === 'pp' ? '' : 'data/popup/index.html'
    });
  }
});
{
  const once = async () => {
    if (once.done) {
      return;
    }
    once.done = true;

    const prefs = await chrome.storage.local.get({
      mode: 'bp'
    });
    chrome.action.setPopup({
      popup: prefs.mode === 'pp' ? '' : 'data/popup/index.html'
    });
  };
  chrome.runtime.onInstalled.addListener(once);
  chrome.runtime.onStartup.addListener(once);
}

{
  const once = () => {
    if (once.done) {
      return;
    }
    once.done = true;

    chrome.contextMenus.create({
      id: 'remove-all-alarms',
      title: 'Remove all Alarms and Timers',
      contexts: ['action']
    });
    chrome.contextMenus.create({
      id: 'remove-all-snoozes',
      title: 'Remove all Snoozes',
      contexts: ['action']
    });
    chrome.contextMenus.create({
      id: 'remove-all-notifications',
      title: 'Remove all Notifications',
      contexts: ['action']
    });
  };
  chrome.runtime.onInstalled.addListener(once);
  chrome.runtime.onStartup.addListener(once);
}
chrome.contextMenus.onClicked.addListener(info => {
  if (info.menuItemId === 'remove-all-alarms') {
    // one serialized flush wipes the mirror and clears every live
    // browser alarm: a direct chrome.alarms.clear here could still be
    // in flight when the wipe's write lands, and the popup re-renders
    // on that write (the flush settles its clears first). cache
    // entries pending from before the click are purged by removeAll
    alarms.removeAll();
  }
  else if (info.menuItemId === 'remove-all-snoozes') {
    alarms.getAll(as => {
      for (const a of as.filter(a => a.name.startsWith('audio-'))) {
        alarms.clear(a.name);
      }
    });
  }
  else if (info.menuItemId === 'remove-all-notifications') {
    notifications.kill();
  }
});

/* FAQs & Feedback */
{
  const {management, runtime: {onInstalled, setUninstallURL, getManifest}, storage, tabs} = chrome;
  if (navigator.webdriver !== true) {
    const {homepage_url: page, name, version} = getManifest();
    onInstalled.addListener(({reason, previousVersion}) => {
      management.getSelf(({installType}) => installType === 'normal' && storage.local.get({
        'faqs': true,
        'last-update': 0
      }, prefs => {
        if (reason === 'install' || (prefs.faqs && reason === 'update')) {
          const doUpdate = (Date.now() - prefs['last-update']) / 1000 / 60 / 60 / 24 > 45;
          if (doUpdate && previousVersion !== version) {
            tabs.query({active: true, lastFocusedWindow: true}, tbs => tabs.create({
              url: page + '?version=' + version + (previousVersion ? '&p=' + previousVersion : '') + '&type=' + reason,
              active: reason === 'install',
              ...(tbs && tbs.length && {index: tbs[0].index + 1})
            }));
            storage.local.set({'last-update': Date.now()});
          }
        }
      }));
    });
    setUninstallURL(page + '?rd=feedback&name=' + encodeURIComponent(name) + '&version=' + version);
  }
}

// worker (re)started: redraw the badge from the current timer state
badge.update();
