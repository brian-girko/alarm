'use strict';

const args = new URLSearchParams(location.search);

// place the window in the user's preferred corner (the same message the
// ring window sends; the worker performs the actual move)
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

const MONTHS = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'
];
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

// same shape as the popup's alarm.format(): "Mon 21 Nov, 08:00"
const format = d => DAYS[d.getDay()] + ', ' + ('0' + d.getDate()).substr(-2) + ' ' +
  MONTHS[d.getMonth()] + ' ' + ('0' + d.getHours()).substr(-2) + ':' + ('0' + d.getMinutes()).substr(-2);

const entries = document.querySelector('[data-id="entries"]');
const clear = document.getElementById('clear');

// identity of a missed record; the worker dedups on the same pair
const key = o => o.name + '@' + o.when;

const save = missed => chrome.storage.local.set({
  'missed-alarms': missed
});

const render = missed => {
  // storage is an untrusted boundary (imported preferences): keep records
  // a row can render (the img lookup derefs name)
  const list = (Array.isArray(missed) ? missed : [])
    .filter(o => o && typeof o.name === 'string');
  entries.textContent = '';

  if (list.length === 0) {
    const p = document.createElement('p');
    p.textContent = 'Nothing was missed.';
    entries.append(p);
  }
  for (const o of list) {
    const row = document.createElement('div');
    row.className = 'entry';

    // the type is spelled out in the title; the image is decorative
    const img = document.createElement('img');
    img.alt = '';
    img.src = o.name.indexOf('alarm') !== -1 ? '../notify/imgs/alarm.svg' :
      (o.name.indexOf('timer') !== -1 ? '../notify/imgs/timer.svg' : '../notify/imgs/stopwatch.svg');

    const text = document.createElement('div');
    const title = document.createElement('div');
    title.className = 'title';
    title.textContent = o.title;
    const when = document.createElement('div');
    when.className = 'when';
    when.textContent = 'was due ' + format(new Date(o.when));
    text.append(title, when);

    const remove = document.createElement('input');
    remove.type = 'button';
    remove.dataset.key = key(o);
    remove.title = 'Remove from the list';
    remove.setAttribute('aria-label', 'Remove "' + o.title + '" from the list');

    row.append(img, text, remove);
    entries.append(row);
  }
  clear.disabled = list.length === 0;
};

// per-entry dismissal; the storage.onChanged listener re-renders
entries.addEventListener('click', e => {
  const k = e.target.dataset.key;
  if (k) {
    chrome.storage.local.get({
      'missed-alarms': []
    }, prefs => {
      // storage is an untrusted boundary (imported preferences); the
      // write also drops records a row cannot render
      save((Array.isArray(prefs['missed-alarms']) ? prefs['missed-alarms'] : [])
        .filter(o => o && typeof o.name === 'string' && key(o) !== k));
    });
  }
});

clear.addEventListener('click', () => save([]));
document.getElementById('done').addEventListener('click', () => window.close());

chrome.storage.onChanged.addListener(ps => {
  if (ps['missed-alarms']) {
    render(ps['missed-alarms'].newValue || []);
  }
});

chrome.storage.local.get({
  'missed-alarms': []
}, prefs => render(prefs['missed-alarms']));
