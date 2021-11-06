'use strict';

const toast = document.getElementById('toast');

chrome.storage.local.get({
  'volume-timer': 0.8,
  'volume-alarm': 0.8,
  'volume-misc': 0.8,
  'mode': 'bp',
  'notify-position': 'center',
  'notify-on-top': false
}, prefs => {
  console.log(prefs);
  document.getElementById('volume-timer').value = prefs['volume-timer'] * 100;
  document.getElementById('volume-alarm').value = prefs['volume-alarm'] * 100;
  document.getElementById('volume-misc').value = prefs['volume-misc'] * 100;
  document.getElementById('mode').value = prefs.mode;
  document.getElementById('notify-position').value = prefs['notify-position'];
  document.getElementById('notify-on-top').checked = prefs['notify-on-top'];
});

document.getElementById('save').addEventListener('submit', e => {
  e.preventDefault();
  chrome.storage.local.set({
    'volume-timer': document.getElementById('volume-timer').value / 100,
    'volume-alarm': document.getElementById('volume-alarm').value / 100,
    'volume-misc': document.getElementById('volume-misc').value / 100,
    'mode': document.getElementById('mode').value,
    'notify-position': document.getElementById('notify-position').value,
    'notify-on-top': document.getElementById('notify-on-top').checked
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
      chrome.runtime.reload();
      window.close();
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
  input.click();

  function readFile() {
    if (input.value !== input.initialValue) {
      const file = input.files[0];
      const reader = new FileReader();
      reader.onloadend = event => {
        input.remove();
        const json = JSON.parse(event.target.result);
        chrome.storage.local.clear(() => {
          chrome.storage.local.set(json, () => chrome.runtime.reload());
        });
      };
      reader.readAsText(file, 'utf-8');
    }
  }
});
