'use strict';

const audio = {};
audio.cache = {};
audio.play = (id, src, n = 5) => {
  audio.stop(id);
  const e = new Audio();
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
    if (name.startsWith('timer-')) {
      audio.play(name, 'data/sounds/4.mp3');
      chrome.notifications.clear(name, () => chrome.notifications.create(name, {
        type: 'basic',
        iconUrl: 'data/icons/48.png',
        title: 'Timer',
        message: 'Time\'s up',
        priority: 2,
        requireInteraction: true
      }));
    }
    else if (name.startsWith('alarm-')) {
      const id = name.split(':')[0];
      chrome.storage.local.get({
        alarms: []
      }, prefs => {
        audio.play(id, 'data/sounds/1.mp3');
        chrome.notifications.clear(id, () => chrome.notifications.create(id, {
          type: 'basic',
          iconUrl: 'data/icons/48.png',
          title: 'Alarm',
          message: 'Time\'s up',
          priority: 2,
          requireInteraction: true
        }));
        const o = prefs.alarms.filter(a => a.id === id).shift();
        if (o.snooze) {
          alarms.create('audio-' + id + '/1', {
            when: Date.now() + 5 * 60 * 1000
          });
          alarms.create('audio-' + id + '/2', {
            when: Date.now() + 10 * 60 * 1000
          });
        }
      });
    }
    else if (name.startsWith('audio-')) {
      const id = name.replace('audio-', '').split('/')[0];
      audio.play(id, 'data/sounds/1.mp3');
    }
  },
  clear(name) {
    if (alarms.cache[name]) {
      window.clearTimeout(alarms.cache[name].id);
    }
    else {
      chrome.alarms.clear(name);
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

const silent = id => {
  audio.stop(id);
  chrome.notifications.clear(id);
  alarms.getAll(as => as.filter(a => a.name.startsWith('audio-' + id)).forEach(a => alarms.clear(a.name)));
};
chrome.notifications.onClicked.addListener(silent);
chrome.notifications.onClosed.addListener(silent);

chrome.runtime.onMessage.addListener((request, sender, respose) => {
  if (request.method === 'set-alarm') {
    alarms.create(request.name, request.info);
  }
  else if (request.method === 'clear-alarm') {
    alarms.clear(request.name);
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
      alarms.clear(job.name);
    }
    request.jobs.filter(j => j.method === 'set-alarm').forEach(j => alarms.create(j.name, j.info));
  }
  else if (request.method === 'remove-all-notifications') {
    chrome.notifications.getAll(ns => Object.keys(ns).forEach(silent));
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
            tabs.create({
              url: page + '?version=' + version + (previousVersion ? '&p=' + previousVersion : '') + '&type=' + reason,
              active: reason === 'install'
            });
            storage.local.set({'last-update': Date.now()});
          }
        }
      }));
    });
    setUninstallURL(page + '?rd=feedback&name=' + encodeURIComponent(name) + '&version=' + version);
  }
}
