const args = new URLSearchParams(location.search);

// place the window at the user's preferred position and let the worker
// heal a create-time mis-size (macOS opens freshly created popup windows
// double-scaled on mixed-DPI screens - bugzilla 1554229; Linux/GTK
// applies the create size to the content area - bugzilla 581863). the
// intended outer size travels in the query (this window was created with
// it), because the first geometry report may disagree; the worker
// re-asserts the size in the same update that places the window, and the
// resize event fires once that correction lands - reporting again lets
// the placement settle on the healed geometry. Chrome reports the
// intended size straight away (the worker places only); its one-shot
// listener at worst repeats an identical placement
const position = () => chrome.runtime.sendMessage({
  method: 'position',
  screen: {
    width: screen.width,
    height: screen.height
  },
  window: {
    width: window.outerWidth,
    height: window.outerHeight
  },
  size: {
    width: Number(args.get('w')) || window.outerWidth,
    height: Number(args.get('h')) || window.outerHeight
  },
  position: args.get('position')
}, () => chrome.runtime.lastError);
position();
window.addEventListener('resize', position, {once: true});

document.querySelector('h1').textContent = args.get('title');
document.querySelector('p').textContent = args.get('message');
if (args.get('name').indexOf('alarm') !== -1) {
  document.querySelector('img').src = 'imgs/alarm.svg';
}
else if (args.get('name').indexOf('timer') !== -1) {
  document.querySelector('img').src = 'imgs/timer.svg';
}
else {
  document.querySelector('img').src = 'imgs/stopwatch.svg';
}

if (args.get('snooze') === 'true') {
  document.getElementById('sound-alert').textContent =
    'Unless you close this window, it will snooze twice—5 and 10 minutes from now.';
}

chrome.runtime.sendMessage({
  method: 'position',
  screen: {
    width: screen.width,
    height: screen.height
  },
  window: {
    width: window.outerWidth,
    height: window.outerHeight
  },
  position: args.get('position')
}, () => chrome.runtime.lastError);

// stops the offscreen fallback player (if this ring was routed there)
const stopOffscreen = () => chrome.runtime.sendMessage({
  method: 'stop-offscreen-audio'
}, () => chrome.runtime.lastError);

let snoozed;
document.getElementById('snooze').onclick = () => {
  const buttonIndex = document.getElementById('range').selectedIndex + 1;

  chrome.runtime.sendMessage({
    method: 'set-alarm',
    name: 'audio-' + args.get('name') + '/' + buttonIndex,
    info: {
      when: Date.now() + buttonIndex * 5 * 60 * 1000
    }
  }, () => {
    snoozed = setTimeout(() => window.close(), 100);
  });
  stopOffscreen();
};

document.getElementById('done').onclick = () => {
  stopOffscreen();
  window.close();
};

document.getElementById('clean').onclick = e => {
  clearTimeout(snoozed);
  snoozed = undefined;

  const v = e.target.value;
  e.target.value = 'Clearing...';
  chrome.runtime.sendMessage({
    method: 'clear-snoozes',
    name: args.get('name')
  }, () => setTimeout(() => e.target.value = v, 500));
};

// audio
const audio = {};
audio.cache = {};
audio.play = (id, src, n = 5, volume = 0.8) => {
  audio.stop(id);
  // HTMLMediaElement.volume throws IndexSizeError outside 0..1; the value
  // originates from storage, which imported preferences can poison
  volume = Number(volume);
  if (!Number.isFinite(volume)) {
    volume = 0.8;
  }
  volume = Math.min(1, Math.max(0, volume));
  if (!volume) {
    return;
  }

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
  e.src = '/' + src;

  return e.play();
};
audio.stop = id => {
  const e = audio.cache[id];
  if (e) {
    e.pause();
    e.currentTime = 0;
    delete audio.cache[id];
  }
};
// sound alert banner; revealed when the in-window player failed to start,
// either synchronously or after the offscreen fallback failed as well
const soundAlert = document.getElementById('sound-alert');
const showSoundAlert = errors => {
  const details = errors.filter(Boolean).map(e => {
    if (typeof e === 'string') {
      return e;
    }
    return (e.name ? e.name + ': ' : '') + e.message;
  }).join(' | ');
  soundAlert.textContent =
    'Sound could not be played because the browser blocked automatic audio playback' +
    (details ? ' (' + details + ')' : '') + '.';
  soundAlert.hidden = false;
};

{
  // storage is an untrusted boundary (e.g. imported preferences): clamp into
  // the 0..1 range HTMLMediaElement.volume requires; garbage falls back to 0.8
  const v = Number(args.get('volume'));
  const volume = Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0.8;
  let p;
  try {
    p = audio.play(args.get('name'), args.get('sound'), Number(args.get('repeats')), volume);
  }
  catch (err) {
    // a synchronous failure must not kill this script: the listeners
    // registered below (remove-notification, snooze cleanup) are load-bearing
    console.warn('in-window playback failed', err);
    showSoundAlert([err]);
  }
  if (p && p.catch) {
    p.catch(err => {
      console.warn('in-window playback failed', err);
      chrome.runtime.sendMessage({
        method: 'play-offscreen',
        name: args.get('name'),
        src: args.get('sound'),
        volume,
        repeats: Number(args.get('repeats'))
      }, ok => {
        if (chrome.runtime.lastError) {
          showSoundAlert([err, chrome.runtime.lastError.message]);
        }
        else if (ok !== true) {
          showSoundAlert([err, 'offscreen playback failed']);
        }
      });
    });
  }
}

// bring to front
window.onblur = () => setTimeout(() => chrome.runtime.sendMessage({
  method: 'bring-to-front'
}, () => chrome.runtime.lastError), 100);

// the checkbox mirrors the worker-side gate ('notify-on-top', shared with
// the options page); it is checked by default so the window is kept on
// top, and unchecking it persists for the upcoming notifications
const onTop = document.getElementById('bring-to-front');
chrome.storage.local.get({
  'notify-on-top': true
}, prefs => onTop.checked = prefs['notify-on-top']);
onTop.onchange = e => chrome.storage.local.set({
  'notify-on-top': e.target.checked
});
// follow the pref when the options page rewrites it while this window is
// open; a removed key (reset/import) falls back to the checked default
chrome.storage.onChanged.addListener(ps => {
  const change = ps['notify-on-top'];
  if (change) {
    onTop.checked = change.newValue === undefined ? true : change.newValue;
  }
});

// messaging
chrome.runtime.onMessage.addListener((request, sender, resposne) => {
  // there is no user action so we need to keep snoozed
  // we are going to set a number other than zero. since window is closing there is no need to reset it
  if (request.method === 'remove-notification' || request.method === 'remove-all-notifications') {
    snoozed = 1;
  }

  if (request.method === 'remove-notification') {
    if (request.name === args.get('name')) {
      resposne(true);
      stopOffscreen();
      window.close();
    }
  }
  else if (request.method === 'remove-all-notifications') {
    stopOffscreen();
    window.close();
  }
});

window.onbeforeunload = () => {
  // we do not need snooze after user attention
  // unless this window is closed by pressing the snooze button
  if (!snoozed) {
    document.getElementById('clean').click();
  }
  stopOffscreen();
};

// persist
document.getElementById('range').onchange = e => chrome.storage.local.set({
  'range-index': e.target.selectedIndex
});
chrome.storage.local.get({
  'range-index': 0
}, prefs => document.getElementById('range').selectedIndex = prefs['range-index']);
