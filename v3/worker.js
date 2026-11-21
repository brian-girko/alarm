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
// startup pass that found newly missed entries (the page lists every
// undismissed record, not just the fresh ones)
const missed = {
  open() {
    chrome.storage.local.get({
      'notify-position': 'center' // center, br, tr
    }, prefs => {
      const args = new URLSearchParams();
      args.set('position', prefs['notify-position']);
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
    if (info.when && info.when < from) {
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
      const raw = prefs.alarms.filter(a => a.id === id).shift();
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
      const o = prefs.alarms.filter(a => a.id === id).shift();
      set(id, title, prefs['src-misc'], prefs['repeats-misc'], prefs['volume-misc'], o?.name);
    }
  },
  get(name, c) {
    chrome.alarms.get(name, c);
  },
  getAll(c) {
    chrome.alarms.getAll(as => c(as.filter(a => a.name !== BADGE_TICK)));
  }
};

// create or clear
{
  const cache = {
    create: new Map(),
    clear: new Set()
  };
  const step = () => {
    clearTimeout(step.id);
    step.id = setTimeout(() => {
      alarms.getAll(as => {
        chrome.storage.local.get({
          'alarms-storage': {}
        }, prefs => {
          // clear old alarms
          const keys = [
            ...cache.clear.keys(),
            ...cache.create.keys()
          ].map(s => s.split(':')[0]);

          // slot names are '<id>:<index>', so require the ':' delimiter to
          // avoid sweeping prefix-colliding ids ('alarm-0.8' vs 'alarm-0.81');
          // colon-less names (timer-1, snoozes) must equal their key exactly
          for (const a of as.filter(a => keys.some(key => a.name === key || a.name.startsWith(key + ':')))) {
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
          // set new alarms
          for (const [name, info] of cache.create) {
            jobs.push(chrome.alarms.create(name, info));
            prefs['alarms-storage'][name] = info;
          }
          cache.create.clear();
          chrome.storage.local.set(prefs);
          Promise.allSettled(jobs).then(() => badge.update());
        });
      });
    }, 100);
  };

  alarms.create = (name, info) => {
    cache.create.set(name, info);
    cache.clear.delete(name);
    step();
  };
  alarms.clear = (name, callback = () => {}) => {
    cache.clear.add(name);
    cache.create.delete(name);
    callback();
    step();
  };

  alarms.fire = new Proxy(alarms.fire, {
    apply(target, self, args) {
      const o = args[0];
      if (!o.periodInMinutes) {
        chrome.storage.local.get({
          'alarms-storage': {}
        }, prefs => {
          delete prefs['alarms-storage'][o.name];
          chrome.storage.local.set(prefs);
        });
      }

      return Reflect.apply(target, self, args);
    }
  });
}
{
  const once = async () => {
    if (once.done) {
      return;
    }
    once.done = true;

    const prefs = await chrome.storage.local.get({
      'alarms-storage': {},
      'alarms': [],
      'missed-alarms': []
    });
    // storage is an untrusted boundary (imported preferences): repair a
    // corrupted list in place so the append below cannot throw
    prefs['missed-alarms'] = Array.isArray(prefs['missed-alarms']) ? prefs['missed-alarms'] : [];
    const defs = new Map(prefs.alarms.map(a => [a.id, a]));
    const {changed, fresh} = normalizeStorage(defs, prefs['alarms-storage'], prefs['missed-alarms']);
    for (const [name, info] of Object.entries(prefs['alarms-storage'])) {
      const o = await chrome.alarms.get(name);
      if (!o || (name.startsWith('alarm-') && o.scheduledTime !== info.when)) {
        await chrome.alarms.create(name, info);
        console.info('Force Creating a new Alarm', name, info);
      }
    }
    if (changed) {
      // awaited so the missed window (opened below) reads the fresh list
      await chrome.storage.local.set(prefs);
    }
    if (fresh) {
      missed.open();
    }
    badge.update();
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
      const defs = new Map(prefs.alarms.map(a => [a.id, a]));
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
    chrome.storage.local.get({
      'notify-on-top': false
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
    if (request.position === 'center') {
      chrome.windows.update(sender.tab.windowId, {
        left: parseInt((request.screen.width - request.window.width) / 2),
        top: parseInt((request.screen.height - request.window.height) / 2)
      });
    }
    else if (request.position === 'br') {
      chrome.windows.update(sender.tab.windowId, {
        left: parseInt(request.screen.width - request.window.width),
        top: parseInt(request.screen.height - request.window.height)
      });
    }
    else if (request.position === 'tr') {
      chrome.windows.update(sender.tab.windowId, {
        left: parseInt(request.screen.width - request.window.width),
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
    alarms.getAll(as => {
      Promise.allSettled(as.map(a => chrome.alarms.clear(a.name))).then(() => badge.update());
    });
    chrome.storage.local.set({
      'alarms-storage': {}
    });
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
