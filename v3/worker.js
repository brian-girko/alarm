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
  create(name, opts) {
    const args = new URLSearchParams();
    args.set('name', name);
    args.set('title', opts.title);
    args.set('message', opts.message);
    args.set('sound', opts.sound);
    args.set('volume', opts.volume);
    args.set('repeats', opts.repeats);

    chrome.storage.local.get({
      'notify-position': 'center' // center, br, tr
    }, prefs => {
      args.set('position', prefs['notify-position']);

      const p = {
        width: 580,
        height: 250,
        type: 'popup',
        url: 'data/notify/index.html?' + args.toString()
      };
      chrome.windows.create(p);
    });
  },
  kill() {
    chrome.runtime.sendMessage({
      method: 'remove-all-notifications'
    }, () => chrome.runtime.lastError);
  }
};

const alarms = {
  fire({name}) {
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
      chrome.storage.local.get({
        'src-timer': 'data/sounds/4.mp3',
        'repeats-timer': 5,
        'volume-timer': 0.8
      }, prefs => {
        set(name, 'Timer', prefs['src-timer'], prefs['repeats-timer'], prefs['volume-timer']);
      });
    }
    else if (name.startsWith('alarm-')) {
      const id = name.split(':')[0];
      chrome.storage.local.get({
        'alarms': [],
        'src-alarm': 'data/sounds/1.mp3',
        'repeats-alarm': 5,
        'volume-alarm': 0.8
      }, prefs => {
        const o = prefs.alarms.filter(a => a.id === id).shift();
        if (o.snooze) {
          alarms.create('audio-' + id + '/1', {
            when: Date.now() + 5 * 60 * 1000
          });
          alarms.create('audio-' + id + '/2', {
            when: Date.now() + 10 * 60 * 1000
          });
        }
        set(id, 'Alarm', prefs['src-alarm'], prefs['repeats-alarm'], prefs['volume-alarm'], o.name);
      });
    }
    else if (name.startsWith('audio-')) {
      const id = name.replace('audio-', '').split('/')[0];
      chrome.storage.local.get({
        'alarms': [],
        'src-misc': 'data/sounds/5.mp3',
        'repeats-misc': 5,
        'volume-misc': 0.8
      }, prefs => {
        let title = 'Misc';
        if (id.startsWith('alarm-')) {
          title = 'Alarm';
        }
        else if (id.startsWith('timer-')) {
          title = 'Timer';
        }
        const o = prefs.alarms.filter(a => a.id === id).shift();
        set(id, title, prefs['src-misc'], prefs['repeats-misc'], prefs['volume-misc'], o?.name);
      });
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
  const once = () => chrome.storage.local.get({
    'alarms-storage': {}
  }, async prefs => {
    const now = Date.now();
    let modified = false;
    for (const [name, info] of Object.entries(prefs['alarms-storage'])) {
      if (info.when && info.when < now) {
        if (info.periodInMinutes) {
          while (info.when < now) {
            info.when += info.periodInMinutes * 60 * 1000;
          }
        }
        else {
          delete prefs['alarms-storage'][name];
        }
        modified = true;
      }
      if (name in prefs['alarms-storage']) {
        const o = await chrome.alarms.get(name);
        if (!o) {
          chrome.alarms.create(name, info);
          console.info('Force Creating a new Alarm', name, info);
        }
      }
    }
    if (modified) {
      chrome.storage.local.set(prefs);
    }
  });
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
    chrome.alarms.getAll().then(os => {
      for (const o of os) {
        if (o.scheduledTime < now) {
          alarms.create(o.name, {
            when: now + 1000,
            periodInMinutes: o.periodInMinutes
          });
        }
      }
    });
  }
});

const onMessage = (request, sender, respose) => {
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

const onCommand = command => {
  if (command === 'open-interface') {
    chrome.windows.getCurrent(win => chrome.storage.local.get({
      width: 400,
      height: 600,
      left: win.left + Math.round((win.width - 400) / 2),
      top: win.top + Math.round((win.height - 600) / 2)
    }, prefs => chrome.windows.create({
      url: 'data/popup/index.html?mode=pp',
      width: prefs.width,
      height: prefs.height,
      left: prefs.left,
      top: prefs.top,
      type: 'popup'
    })));
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
  const once = () => chrome.storage.local.get({
    mode: 'bp'
  }, prefs => chrome.action.setPopup({
    popup: prefs.mode === 'pp' ? '' : 'data/popup/index.html'
  }));
  chrome.runtime.onInstalled.addListener(once);
  chrome.runtime.onStartup.addListener(once);
}

{
  const once = () => {
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
    const page = getManifest().homepage_url;
    const {name, version} = getManifest();
    onInstalled.addListener(({reason, previousVersion}) => {
      management.getSelf(({installType}) => installType === 'normal' && storage.local.get({
        'faqs': true,
        'last-update': 0
      }, prefs => {
        if (reason === 'install' || (prefs.faqs && reason === 'update')) {
          const doUpdate = (Date.now() - prefs['last-update']) / 1000 / 60 / 60 / 24 > 45;
          if (doUpdate && previousVersion !== version) {
            tabs.query({active: true, currentWindow: true}, tbs => tabs.create({
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
