'use strict';

const timer = {};
window.timer = timer;

const hours = document.querySelector('.timer input[data-id="hours"]');
const minutes = document.querySelector('.timer input[data-id="minutes"]');
const seconds = document.querySelector('.timer input[data-id="seconds"]');


timer.ms2time = duration => ({
  seconds: Math.floor((duration / 1000) % 60),
  minutes: Math.floor((duration / (1000 * 60)) % 60),
  hours: Math.floor((duration / (1000 * 60 * 60)) % 24)
});

timer.format = num => ('00' + num).substr(-2);

timer.tick = (once = false) => {
  const n = timer.when - Date.now();

  if (n > 0) {
    const o = timer.ms2time(n);
    hours.value = timer.format(o.hours);
    minutes.value = timer.format(o.minutes);
    seconds.value = timer.format(o.seconds);

    window.clearTimeout(timer.id);
    if (once !== true) {
      timer.id = window.setTimeout(timer.tick, 1000);
    }
  }
  else {
    timer.pause(true);
  }
};

timer.start = () => {
  hours.value = timer.format(Math.max(0, hours.value));
  minutes.value = timer.format(Math.min(59, Math.max(0, minutes.value)));
  seconds.value = timer.format(Math.min(59, Math.max(0, seconds.value)));

  const when = ((Number(hours.value) * 60 + Number(minutes.value)) * 60 + Number(seconds.value)) * 1000;
  if (when) {
    timer.resume(Date.now() + when, 1000);
  }
  else {
    timer.pause(true);
  }
};

timer.pause = (reset = false) => {
  window.clearTimeout(timer.id);
  chrome.runtime.sendMessage({
    method: 'clear-alarm',
    name: 'timer-1'
  });
  if (reset) {
    hours.value = '00';
    minutes.value = '30';
    seconds.value = '00';
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

  window.clearTimeout(timer.id);
  if (delay >= 0) {
    if (post) {
      chrome.runtime.sendMessage({
        method: 'set-alarm',
        name: 'timer-1',
        info: {
          when: timer.when
        }
      });
    }
    timer.id = window.setTimeout(timer.tick, delay);
    document.body.dataset.timer = 'working';
  }
  else {
    timer.tick(true);
    document.body.dataset.timer = 'paused';
  }
};

// restore
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
