'use strict';

const toast = document.getElementById('toast');

chrome.storage.local.get({
  'volume-timer': 0.8,
  'volume-alarm': 0.8,
  'volume-misc': 0.8
}, prefs => {
  document.getElementById('volume-timer').value = prefs['volume-timer'] * 100;
  document.getElementById('volume-alarm').value = prefs['volume-alarm'] * 100;
  document.getElementById('volume-misc').value = prefs['volume-misc'] * 100;
});

document.getElementById('save').addEventListener('submit', e => {
  e.preventDefault();
  chrome.storage.local.set({
    'volume-timer': document.getElementById('volume-timer').value / 100,
    'volume-alarm': document.getElementById('volume-alarm').value / 100,
    'volume-misc': document.getElementById('volume-misc').value / 100
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
