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
  create(name, info) {
    chrome.alarms.getAll(as => {
      const id = name.split(':')[0];
      const names = as.filter(a => a.name.indexOf(id) !== -1).map(a => a.name);
      for (const name of names) {
        chrome.alarms.clear(name);
      }
      chrome.alarms.create(name, info);
    });

    // const d = info.when - Date.now();
    // if (d < 60 * 1000) {
    //   if (alarms.cache[name]) {
    //     clearTimeout(alarms.cache[name].id);
    //   }
    //   alarms.cache[name] = {
    //     id: setTimeout(() => {
    //       delete alarms.cache[name];
    //       alarms.fire({
    //         name,
    //         scheduledTime: info.when
    //       });
    //     }, d),
    //     when: info.when
    //   };
    // }
    // else {
    //   chrome.alarms.create(name, info);
    // }
  },
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
  clear(name, callback = () => {}) {
    if (alarms.cache[name]) {
      clearTimeout(alarms.cache[name].id);
      delete alarms.cache[name];
      callback();
    }
    else {
      chrome.alarms.clear(name, callback);
    }
  },
  get(name, c) {
    if (alarms.cache[name]) {
      c({
        name,
        scheduledTime: alarms.cache[name].when
      });
    }
    else {
      chrome.alarms.get(name, c);
    }
  },
  getAll(c) {
    const locals = Object.entries(alarms.cache).map(([name, {when}]) => {
      return {
        name,
        scheduledTime: when
      };
    });
    chrome.alarms.getAll(alarms => c([
      ...locals,
      ...alarms
    ]));
  }
};
alarms.cache = {};
chrome.alarms.onAlarm.addListener(alarms.fire);

/* handling outdated alarms */
chrome.idle.onStateChanged.addListener(state => {
  if (state === 'active') {
    const now = Date.now();
    chrome.alarms.getAll().then(os => {
      for (const o of os) {
        if (o.scheduledTime < now) {
          chrome.alarms.create(o.name, {
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
  else if (request.method === 'clear-alarm') {
    request.name = request.name.split(':')[0];
    alarms.getAll(as => {
      as = as.filter(a => a.name.indexOf(request.name) !== -1);
      as.forEach(a => {
        alarms.clear(a.name);
      });
    });
  }
  else if (request.method === 'get-alarm') {
    alarms.get(request.name, respose);
    return true;
  }
  else if (request.method === 'get-alarms') {
    alarms.getAll(respose);
    return true;
  }
  else if (request.method === 'batch') {
    const sets = request.jobs.filter(j => j.method === 'set-alarm').map(j => j.name);
    const clears = request.jobs.filter(j => j.method === 'clear-alarm').filter(j => sets.indexOf(j.name) === -1);
    for (const job of clears) {
      onMessage({
        method: 'clear-alarm',
        name: job.name
      });
    }
    request.jobs.filter(j => j.method === 'set-alarm').forEach(j => alarms.create(j.name, j.info));
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
