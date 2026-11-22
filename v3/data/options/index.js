'use strict';

const toast = document.getElementById('toast');

// preferences are also written by the unvalidated import; keep volumes in the
// 0..1 range HTMLMediaElement.volume requires (garbage falls back to 0.8)
const clamp01 = v => {
  v = Number(v);
  return Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0.8;
};

// refresh the form from the stored preferences; re-run after an import
// or reset, which replace them wholesale
const load = () => chrome.storage.local.get({
  'volume-timer': 0.8,
  'volume-alarm': 0.8,
  'volume-misc': 0.8,
  'mode': 'bp',
  'notify-position': 'center',
  'notify-on-top': true,
  'badge-enabled': true,
  'badge-color': '#1a73e8'
}, prefs => {
  document.getElementById('volume-timer').value = clamp01(prefs['volume-timer']) * 100;
  document.getElementById('volume-alarm').value = clamp01(prefs['volume-alarm']) * 100;
  document.getElementById('volume-misc').value = clamp01(prefs['volume-misc']) * 100;
  document.getElementById('mode').value = prefs.mode;
  document.getElementById('notify-position').value = prefs['notify-position'];
  document.getElementById('notify-on-top').checked = prefs['notify-on-top'];
  document.getElementById('badge-enabled').checked = prefs['badge-enabled'];
  document.getElementById('badge-color').value = prefs['badge-color'];
  document.getElementById('badge-color').disabled = !prefs['badge-enabled'];
});
load();
document.getElementById('badge-enabled').addEventListener('change', e => {
  document.getElementById('badge-color').disabled = !e.target.checked;
});
// the notification window can rewrite 'notify-on-top' while this form is
// open (its top-right checkbox); keep the form's checkbox in sync so a
// later Save cannot silently revert that change. A removed key
// (reset/import) falls back to the checked default, like load() does.
chrome.storage.onChanged.addListener(ps => {
  const change = ps['notify-on-top'];
  if (change) {
    document.getElementById('notify-on-top').checked =
      change.newValue === undefined ? true : change.newValue;
  }
});

document.getElementById('save').addEventListener('submit', e => {
  e.preventDefault();
  chrome.storage.local.set({
    'volume-timer': clamp01(document.getElementById('volume-timer').value / 100),
    'volume-alarm': clamp01(document.getElementById('volume-alarm').value / 100),
    'volume-misc': clamp01(document.getElementById('volume-misc').value / 100),
    'mode': document.getElementById('mode').value,
    'notify-position': document.getElementById('notify-position').value,
    'notify-on-top': document.getElementById('notify-on-top').checked,
    'badge-enabled': document.getElementById('badge-enabled').checked,
    'badge-color': document.getElementById('badge-color').value
  }, () => {
    toast.textContent = 'Options saved!';
    window.setTimeout(() => toast.textContent = '', 750);
  });
});

// reset
document.getElementById('reset').addEventListener('click', e => {
  if (e.detail === 1) {
    toast.textContent = 'Double-click to reset!';
    window.setTimeout(() => toast.textContent = '', 750);
  }
  else {
    localStorage.clear();
    chrome.storage.local.clear(() => {
      // the live alarms survive a plain reload; make the worker rebuild
      // the (now empty) live set from the (now empty) mirror instead
      chrome.runtime.sendMessage({
        method: 'restore-alarms'
      }, () => chrome.runtime.lastError);
      toast.textContent = 'Preferences reset!';
      window.setTimeout(() => toast.textContent = '', 750);
      load();
    });
  }
});
// support
document.getElementById('support').addEventListener('click', () => chrome.tabs.create({
  url: chrome.runtime.getManifest().homepage_url + '?rd=donate'
}));
// export
document.getElementById('export').addEventListener('click', () => {
  chrome.storage.local.get(null, prefs => {
    const text = JSON.stringify(prefs, null, '\t');
    const blob = new Blob([text], {type: 'application/json'});
    const objectURL = URL.createObjectURL(blob);
    Object.assign(document.createElement('a'), {
      href: objectURL,
      type: 'application/json',
      download: 'alarm-preferences.json'
    }).dispatchEvent(new MouseEvent('click'));
    setTimeout(() => URL.revokeObjectURL(objectURL));
  });
});
// import
document.getElementById('import').addEventListener('click', () => {
  const input = document.createElement('input');
  input.style.display = 'none';
  input.type = 'file';
  input.accept = '.json';
  input.acceptCharset = 'utf-8';

  document.body.appendChild(input);
  input.initialValue = input.value;
  input.onchange = readFile;
  input.addEventListener('cancel', () => input.remove());
  input.click();

  function readFile() {
    if (input.value === input.initialValue) {
      return;
    }
    const file = input.files[0];
    const reader = new FileReader();
    reader.onloadend = event => {
      input.remove();
      if (event.target.error) {
        report('Import failed: could not read the file.');
        return;
      }
      importPrefs(event.target.result);
    };
    reader.readAsText(file, 'utf-8');
  }

  // validate and sanitize before clearing anything, so a bad file is a no-op;
  // unknown keys pass through untouched to keep the export a full backup
  function importPrefs(text) {
    let json;
    try {
      json = JSON.parse(text);
    }
    catch (e) {
      report('Import failed: not a valid JSON file.');
      return;
    }
    if (!json || typeof json !== 'object' || Array.isArray(json)) {
      report('Import failed: the file does not contain a preferences object.');
      return;
    }
    // dropped keys fall back to the defaults chrome.storage.local.get applies
    const clean = Object.assign({}, json);
    for (const key of ['volume-timer', 'volume-alarm', 'volume-misc']) {
      if (key in clean) {
        clean[key] = clamp01(clean[key]);
      }
    }
    if (!['bp', 'pp'].includes(clean.mode)) {
      delete clean.mode;
    }
    if (!['center', 'br', 'tr', 'random'].includes(clean['notify-position'])) {
      delete clean['notify-position'];
    }
    for (const key of ['notify-on-top', 'badge-enabled']) {
      if (typeof clean[key] !== 'boolean') {
        delete clean[key];
      }
    }
    if (!/^#[0-9a-f]{6}$/i.test(String(clean['badge-color']))) {
      delete clean['badge-color'];
    }
    // the alarm definitions are repaired at read time (schedule.normalize
    // in the popup and the worker), so the import only drops values that
    // cannot carry a definition at all; a valid backup keeps importing
    // byte-identical
    if ('alarms' in clean) {
      if (Array.isArray(clean.alarms)) {
        clean.alarms = clean.alarms.filter(a =>
          a !== null && typeof a === 'object' && Array.isArray(a) === false);
      }
      else {
        // not an array: drop the key, the storage defaults apply on read
        delete clean.alarms;
      }
    }
    chrome.storage.local.clear(() => {
      if (chrome.runtime.lastError) {
        report('Import failed: ' + chrome.runtime.lastError.message);
        return;
      }
      chrome.storage.local.set(clean, () => {
        if (chrome.runtime.lastError) {
          report('Import failed: ' + chrome.runtime.lastError.message);
          return;
        }
        // runtime.reload() fires neither onInstalled nor onStartup, so
        // the imported alarms-storage would stay unrestored until the
        // next browser start (and the pre-import live alarms would keep
        // ringing); rebuild the live set explicitly instead
        chrome.runtime.sendMessage({
          method: 'restore-alarms'
        }, () => chrome.runtime.lastError);
        load();
        report('Preferences imported!');
      });
    });
  }

  function report(message) {
    toast.textContent = message;
    window.setTimeout(() => toast.textContent = '', 2000);
  }
});
