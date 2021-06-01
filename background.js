'use strict';

const isFirefox = /Firefox/.test(navigator.userAgent) || typeof InstallTrigger !== 'undefined';

const audio = {};
audio.cache = {};
audio.play = (id, src, n = 5, volume = 0.8) => {
  audio.stop(id);
  const e = new Audio();
  e.volume = volume;
  e.addEventListener('ended', function() {
    n -= 1;
    if (n > 0) {
      e.currentTime = 0;
      e.play();
    }
    else {
      delete audio.cache[id];
    }
  }, false);
  audio.cache[id] = e;
  e.src = src;
  e.play();
};
audio.stop = id => {
  const e = audio.cache[id];
  if (e) {
    e.pause();
    e.currentTime = 0;
    delete audio.cache[id];
  }
};

const alarms = {
  create(name, info) {
    const d = info.when - Date.now();
    if (d < 60 * 1000) {
      if (alarms.cache[name]) {
        window.clearTimeout(alarms.cache[name].id);
      }
      alarms.cache[name] = {
        id: window.setTimeout(() => {
          delete alarms.cache[name];
          alarms.fire({
            name,
            scheduledTime: info.when
          });
        }, d),
        when: info.when
      };
    }
    else {
      chrome.alarms.create(name, info);
    }
  },
  fire({name}) {
    const set = (name, title, message = `Time's up`) => chrome.notifications.clear(name, () => {
      const opts = {
        type: 'basic',
        iconUrl: 'data/icons/48.png',
        title,
        message: message + '\n\n' + (new Date()).toLocaleString(),
        priority: 2,
        requireInteraction: true,
        buttons: [{
          title: 'Snooze after 5 minutes'
        }, {
          title: 'Snooze after 10 minutes'
        }]
      };
      if (isFirefox) {
        delete opts.buttons;
        delete opts.requireInteraction;
      }
      chrome.notifications.create(name, opts);
    });

    if (name.startsWith('timer-')) {
      chrome.storage.local.get({
        'src-timer': 'data/sounds/4.mp3',
        'repeats-timer': 5,
        'volume-timer': 0.8
      }, prefs => {
        audio.play(name, prefs['src-timer'], prefs['repeats-timer'], prefs['volume-timer']);
        set(name, 'Timer');
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
        audio.play(id, prefs['src-alarm'], prefs['repeats-alarm'], prefs['volume-alarm']);
        set(id, 'Alarm', o.name);
      });
    }
    else if (name.startsWith('audio-')) {
      const id = name.replace('audio-', '').split('/')[0];
      chrome.storage.local.get({
        'src-misc': 'data/sounds/5.mp3',
        'repeats-misc': 5,
        'volume-misc': 0.8
      }, prefs => {
        audio.play(id, prefs['src-misc'], prefs['repeats-misc'], prefs['volume-misc']);
        let title = 'Misc';
        if (id.startsWith('alarm-')) {
          title = 'Alarm';
        }
        else if (id.startsWith('timer-')) {
          title = 'Timer';
        }
        set(id, title);
      });
    }
  },
  clear(name, callback = () => {}) {
    if (alarms.cache[name]) {
      window.clearTimeout(alarms.cache[name].id);
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

const silent = (id, callback = () => {}) => {
  audio.stop(id);
  chrome.notifications.clear(id);

  alarms.getAll(as => {
    as = as.filter(a => a.name.startsWith('audio-' + id));
    const v = as.map(a => new Promise(resolve => alarms.clear(a.name, resolve)));
    Promise.all(v).then(callback);
  });
};
chrome.notifications.onClicked.addListener(id => silent(id));
chrome.notifications.onClosed.addListener(id => silent(id));

if (chrome.notifications.onShowSettings) {
  chrome.notifications.onShowSettings.addListener(id => silent(id));
}
if (chrome.notifications.onPermissionLevelChanged) {
  chrome.notifications.onPermissionLevelChanged.addListener(id => silent(id));
}
chrome.notifications.onButtonClicked.addListener((id, buttonIndex) => {
  silent(id, () => {
    buttonIndex += 1;
    alarms.create('audio-' + id + '/' + buttonIndex, {
      when: Date.now() + buttonIndex * 5 * 60 * 1000
    });
  });
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
    chrome.notifications.getAll(ns => Object.keys(ns).forEach(silent));
  }
};
chrome.runtime.onMessage.addListener(onMessage);

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
