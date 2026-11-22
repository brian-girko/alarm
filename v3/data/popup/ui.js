/* globals timer, stopwatch, alarm */
'use strict';

const args = new URLSearchParams(location.search);
const mode = args.get('mode');

// the standalone window opens with ?mode=pp; the toolbar popup has no query
document.documentElement.classList.add(mode ?? 'bp');

// supports page zoom other than 100% on the popup mode; Firefox-only
// guard: Firefox sizes the panel from the body layout box and re-measures
// it after mutations, so reading the viewport here is circular - the
// pre-layout read pins the body to a placeholder and the panel collapses
// (the alarm-entries flex row absorbs the shrink). the CSS height stands
if (mode !== 'pp' && navigator.userAgent.includes('Firefox') === false) {
  document.body.style.height = (window.visualViewport.height - 1) + 'px';
}

// tabs
document.getElementById('tabs').addEventListener('change', e => {
  const {id} = e.target;
  document.body.dataset.tab = id;
  localStorage.setItem('alarm-tab', id);
});

// plus button
document.getElementById('plus').addEventListener('click', () => {
  const {tab} = document.body.dataset;
  if (tab === 'alarm') {
    alarm.edit();
  }
});

// remove all snoozes
document.getElementById('kill-snoozes').addEventListener('click', async () => {
  const alarms = await chrome.runtime.sendMessage({
    method: 'get-alarms'
  });
  const jobs = alarms.filter(a => a.name.startsWith('audio-')).map(a => ({
    method: 'clear-alarm',
    name: a.name
  }));
  if (jobs.length) {
    const uniques = new Set(alarms.filter(a => a.name.startsWith('audio-')).map(o => o.name.split('/')[0]));
    if (confirm(`Remove ${uniques.size} snooze${uniques.size > 1 ? 's' : ''}?`)) {
      chrome.runtime.sendMessage({
        method: 'batch',
        jobs
      });
    }
  }
});

// tools
document.addEventListener('click', e => {
  const {command} = e.target.dataset;
  const {tab} = document.body.dataset;

  if (tab === 'alarm') {
    if (command === 'cancel') {
      document.body.dataset.alarm = 'view';
    }
    else if (command === 'remove-date') {
      alarm['remove-date'](e.target);
    }
    else if (command) {
      alarm[command]();
    }
  }
  else if (tab === 'timer') {
    if (command === 'cancel') {
      timer.pause(true);
    }
    else if (command === 'resume') {
      timer.start();
    }
    else if (command) {
      timer[command]();
    }
  }
  else if (tab === 'stopwatch' && command) {
    stopwatch[command]();
  }
});

// close all notifications
chrome.runtime.sendMessage({
  method: 'remove-all-notifications'
});

// startup
document.body.dataset.tab = localStorage.getItem('alarm-tab') || 'alarm';
document.getElementById(document.body.dataset.tab).click();
window.addEventListener('load', () => {
  document.body.dataset.ready = true;
});
