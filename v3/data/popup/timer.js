'use strict';

const timer = {};
window.timer = timer;

const hours = document.querySelector('.timer input[data-id="hours"]');
const minutes = document.querySelector('.timer input[data-id="minutes"]');
const seconds = document.querySelector('.timer input[data-id="seconds"]');

// add leading zeros and force range; a cleared (NaN) field counts as 0
const fix = (e, min = 0, max = 23) => {
  const n = Number.isFinite(e.target.valueAsNumber) ? e.target.valueAsNumber : min;
  e.target.value = Math.max(min, Math.min(max, n)).toString().padStart(2, '0');
};
hours.addEventListener('change', e => fix(e, 0, 99));
minutes.addEventListener('change', e => fix(e, 0, 59));
seconds.addEventListener('change', e => fix(e, 0, 59));

document.querySelector('.timer input[data-command="start"]').addEventListener('click', e => {
  if (e.isTrusted) {
    localStorage.setItem('last-used-hours', hours.value);
    localStorage.setItem('last-used-minutes', minutes.value);
    localStorage.setItem('last-used-seconds', seconds.value);
  }
});

timer.ms2time = duration => ({
  seconds: Math.floor((duration / 1000) % 60),
  minutes: Math.floor((duration / (1000 * 60)) % 60),
  hours: Math.floor((duration / (1000 * 60 * 60))) // there is no limit to 24 hours
});

timer.format = num => ('00' + num).substr(-2);

timer.tick = (once = false) => {
  const n = timer.when - Date.now();

  if (n > 0) {
    const o = timer.ms2time(n);
    hours.value = timer.format(o.hours);
    minutes.value = timer.format(o.minutes);
    seconds.value = timer.format(o.seconds);

    clearTimeout(timer.id);
    if (once !== true) {
      timer.id = setTimeout(timer.tick, 1000);
    }
  }
  else {
    timer.pause(true);
  }
};

// parse a field into a clamped non-negative integer; empty/invalid counts as 0
const toInt = (input, max = Infinity) => {
  const n = Number(input.value);
  const v = Math.min(max, Math.max(0, Number.isFinite(n) ? n : 0));
  input.value = timer.format(v);
  return v;
};

timer.start = () => {
  const h = toInt(hours); // hours have no upper bound (no limit to 24 hours)
  const m = toInt(minutes, 59);
  const s = toInt(seconds, 59);

  const when = (h * 3600 + m * 60 + s) * 1000;

  if (when) {
    timer.resume(Date.now() + when, 1000);
  }
  else {
    timer.pause(true);
  }
};

timer.default = () => {
  hours.value = (localStorage.getItem('last-used-hours') || '00').padStart(2, '0');
  minutes.value = (localStorage.getItem('last-used-minutes') || '30').padStart(2, '0');
  seconds.value = (localStorage.getItem('last-used-seconds') || '00').padStart(2, '0');
};

timer.pause = (reset = false) => {
  clearTimeout(timer.id);
  chrome.runtime.sendMessage({
    method: 'clear-alarm',
    name: 'timer-1'
  });
  if (reset) {
    timer.default();

    document.body.dataset.timer = 'start';
    localStorage.removeItem('timer-when');
  }
  else {
    document.body.dataset.timer = 'paused';
    localStorage.setItem('timer-when', timer.when - Date.now());
  }
};

timer.resume = (when = timer.when, delay = 0, post = true) => {
  timer.when = when;

  clearTimeout(timer.id);
  if (delay >= 0) {
    if (post) {
      localStorage.removeItem('timer-when');

      chrome.runtime.sendMessage({
        method: 'set-alarm',
        name: 'timer-1',
        info: {
          when: timer.when
        }
      });
    }
    timer.id = setTimeout(timer.tick, delay);
    document.body.dataset.timer = 'working';
  }
  else {
    timer.tick(true);
    document.body.dataset.timer = 'paused';
  }
};

// restore
timer.default();
chrome.runtime.sendMessage({
  method: 'get-alarm',
  name: 'timer-1'
}, alarm => {
  if (alarm) {
    if (alarm.scheduledTime > Date.now()) {
      return timer.resume(alarm.scheduledTime, 0, false);
    }
  }
  const w = localStorage.getItem('timer-when');
  if (w) {
    timer.resume(Number(w) + Date.now(), -1);
  }
});

document.querySelector('.timer [data-id="presets"]').addEventListener('click', e => {
  const value = e.target.dataset.value;

  if (value) {
    const [hh, mm, ss] = value.split(':');
    hours.value = hh.padStart(2, '0');
    minutes.value = mm.padStart(2, '0');
    seconds.value = ss.padStart(2, '0');
  }
});
