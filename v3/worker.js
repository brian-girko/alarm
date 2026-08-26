'use strict';

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
    else {
      const matched = await clients.matchAll();
      if (matched.some(c => c.url.includes(chrome.runtime.id))) {
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

// compute upcoming absolute times from a stored wall-clock definition.
// calendar-field based (setDate/setHours), so DST transitions are resolved
// with the offset valid on the target date; fixed-period repeats
// (7 * 24 * 60 minutes) would otherwise drift by one hour
const nextOccurrence = (time, days = [], from = Date.now()) => {
  const base = new Date(from);
  base.setSeconds(0);
  const day = base.getDay();
  const list = days.length ? [...days] : [day];
  return list.map(a => (a - day)).map(n => {
    const o = new Date(from);
    o.setDate(base.getDate() + n);
    o.setHours(Number(time.hours), Number(time.minutes), 0, 0);
    while (o.getTime() <= from) {
      o.setDate(o.getDate() + 7);
    }
    return o.getTime();
  }).filter((t, i, l) => l.indexOf(t) === i).sort();
};

// rebuilds alarms-storage entries: weekly alarm slots are re-anchored to
// wall-clock times (fixed-period repeats drift across DST changes) and
// expired entries are dropped. one-shot ("once") slots keep their exact
// toggle-time epoch and simply expire when due - rebuilding them would
// resurrect already-fired occurrences as endless weekly repeats
const normalizeStorage = (defs, storage, from = Date.now()) => {
  let changed = false;
  const ids = new Set(
    Object.keys(storage)
      .filter(n => n.startsWith('alarm-'))
      .map(n => n.split(':')[0])
      .filter(id => defs.has(id))
  );
  for (const id of ids) {
    const o = defs.get(id);
    if (o.once) {
      continue;
    }
    const times = nextOccurrence(o.time, o.days || [], from);
    Object.keys(storage)
      .filter(n => n.startsWith(id + ':'))
      .forEach((n, index) => {
        if (index < times.length) {
          storage[n] = {
            when: times[index],
            periodInMinutes: 7 * 24 * 60
          };
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
        delete storage[name];
      }
      changed = true;
    }
  }
  return changed;
};

const alarms = {
  async fire({name}) {
    const set = (name, title, sound, repeats, volume, message = `Time's up`) => notifications.clear(name, () => {
      notifications.create(name, {
        title,
        message: message + '\n\n' + (new Date()).toLocaleString(),
        sound,
        volume,
        repeats
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
        'repeats-alarm': 5,
        'volume-alarm': 0.8
      });
      const o = prefs.alarms.filter(a => a.id === id).shift();
      if (o?.snooze) {
        alarms.create('audio-' + id + '/1', {
          when: Date.now() + 5 * 60 * 1000
        });
        alarms.create('audio-' + id + '/2', {
          when: Date.now() + 10 * 60 * 1000
        });
      }
      set(id, 'Alarm', prefs['src-alarm'], prefs['repeats-alarm'], prefs['volume-alarm'], o?.name);
      // reschedule upcoming occurrences of recurring alarms from their
      // wall-clock definition; once-alarms must stay one-shot (their
      // remaining slots are already scheduled and drift-free). stale slot
      // names beyond the new count get swept by the clear step
      if (o && !o.once) {
        nextOccurrence(o.time, o.days).forEach((when, index) => alarms.create(id + ':' + index, {
          when,
          periodInMinutes: 7 * 24 * 60
        }));
      }
    }
    else if (name.startsWith('audio-')) {
      const id = name.replace('audio-', '').split('/')[0];
      const prefs = await chrome.storage.local.get({
        'alarms': [],
        'src-misc': 'data/sounds/5.mp3',
        'repeats-misc': 5,
        'volume-misc': 0.8
      });
      let title = 'Misc';
      if (id.startsWith('alarm-')) {
        title = 'Alarm';
      }
      else if (id.startsWith('timer-')) {
        title = 'Timer';
      }
      const o = prefs.alarms.filter(a => a.id === id).shift();
      set(id, title, prefs['src-misc'], prefs['repeats-misc'], prefs['volume-misc'], o?.name);
    }
  },
  get(name, c) {
    chrome.alarms.get(name, c);
  },
  getAll(c) {
    chrome.alarms.getAll(c);
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

          for (const a of as.filter(a => keys.some(key => a.name.includes(key)))) {
            cache.clear.add(a.name);
          }

          // clear alarms
          for (const name of cache.clear) {
            if (cache.create.has(name) === false) {
              chrome.alarms.clear(name);
              delete prefs['alarms-storage'][name];
            }
          }
          cache.clear.clear();
          // set new alarms
          for (const [name, info] of cache.create) {
            chrome.alarms.create(name, info);
            prefs['alarms-storage'][name] = info;
          }
          cache.create.clear();
          chrome.storage.local.set(prefs);
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
      'alarms': []
    });
    const defs = new Map(prefs.alarms.map(a => [a.id, a]));
    const modified = normalizeStorage(defs, prefs['alarms-storage']);
    for (const [name, info] of Object.entries(prefs['alarms-storage'])) {
      const o = await chrome.alarms.get(name);
      if (!o || (name.startsWith('alarm-') && o.scheduledTime !== info.when)) {
        chrome.alarms.create(name, info);
        console.info('Force Creating a new Alarm', name, info);
      }
    }
    if (modified) {
      chrome.storage.local.set(prefs);
    }
  };
  chrome.runtime.onStartup.addListener(once);
  chrome.runtime.onInstalled.addListener(once);
}

chrome.alarms.onAlarm.addListener(a => {
  alarms.fire(a);
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
      for (const o of os) {
        if (o.scheduledTime < now) {
          const def = o.name.startsWith('alarm-') ? defs.get(o.name.split(':')[0]) : null;
          let info;
          if (def && !def.once) {
            info = {
              when: nextOccurrence(def.time, def.days || [], now)[0],
              periodInMinutes: 7 * 24 * 60
            };
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
      for (const a of as) {
        chrome.alarms.clear(a.name);
      }
    });
    chrome.storage.local.set({
      'alarms-storage': {}
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
