'use strict';

const stopwatch = {};
window.stopwatch = stopwatch;

stopwatch.ms2time = duration => ({
  milliseconds: parseInt((duration % 1000) / 100),
  seconds: Math.floor((duration / 1000) % 60),
  minutes: Math.floor((duration / (1000 * 60)) % 60),
  hours: Math.floor((duration / (1000 * 60 * 60)) % 24)
});

stopwatch.format = o => ('0' + o.hours).substr(-2) + ':' +
  ('0' + o.minutes).substr(-2) + ':' +
  ('0' + o.seconds).substr(-2) + '.' +
  ('0' + o.milliseconds).substr(-2);

stopwatch.start = (when = Date.now()) => {
  stopwatch.when = when;
  stopwatch.lastlap = 0;
  localStorage.setItem('stopwatch-when', stopwatch.when);
  localStorage.removeItem('stopwatch-passed');
  stopwatch.step();
};
stopwatch.stop = () => {
  window.clearTimeout(stopwatch.id);
  stopwatch.passed = Date.now() - stopwatch.when;
  localStorage.setItem('stopwatch-passed', stopwatch.passed);
  localStorage.removeItem('stopwatch-when');
  document.body.dataset.stopwatch = 'paused';
};
stopwatch.lap = (d = Date.now() - stopwatch.when, record = true) => {
  document.querySelector('.stopwatch [data-id=center]').classList.add('hidden');
  stopwatch.laps.push(d);
  if (record) {
    localStorage.setItem('stopwatch-laps', JSON.stringify(stopwatch.laps));
  }
  const tr = document.createElement('tr');
  const one = document.createElement('td');
  one.textContent = ('0' + stopwatch.laps.length).substr(-2);
  tr.appendChild(one);
  const two = document.createElement('td');
  const o = stopwatch.ms2time(d);
  two.textContent = stopwatch.format(o);
  tr.appendChild(two);
  {
    const o = stopwatch.ms2time(d - stopwatch.lastlap);
    const three = document.createElement('td');
    three.textContent = stopwatch.format(o);
    tr.appendChild(three);
  }
  stopwatch.lastlap = d;
  if (record) {
    localStorage.setItem('stopwatch-lastlap', d);
  }
  document.querySelector('.stopwatch [data-id=content] tbody').appendChild(tr);
  const root = document.querySelector('.stopwatch [data-id=content]');
  root.scrollTop = root.scrollHeight;
};
stopwatch.laps = [];
stopwatch.reset = () => {
  document.querySelector('.stopwatch [data-id=center]').classList.remove('hidden');
  localStorage.removeItem('stopwatch-when');
  localStorage.removeItem('stopwatch-passed');
  localStorage.removeItem('stopwatch-lastlap');
  localStorage.removeItem('stopwatch-laps');
  stopwatch.laps = [];
  document.body.dataset.stopwatch = 'start';
  document.querySelector('.stopwatch [data-id=content] tbody').textContent = '';
  stopwatch.when = Date.now();
  stopwatch.step(true);
};
stopwatch.resume = () => {
  localStorage.removeItem('stopwatch-passed');
  stopwatch.when = Date.now() - stopwatch.passed;
  localStorage.setItem('stopwatch-when', stopwatch.when);
  stopwatch.step();
};
{
  const e = document.querySelector('.stopwatch [data-id="counter"]');
  stopwatch.step = (once = false) => {
    const d = Date.now() - stopwatch.when;
    const o = stopwatch.ms2time(d);
    e.textContent = stopwatch.format(o);
    window.clearTimeout(stopwatch.id);
    if (once !== true) {
      stopwatch.id = window.setTimeout(stopwatch.step, 385);
      document.body.dataset.stopwatch = 'working';
    }
  };
}

// init
{
  const when = localStorage.getItem('stopwatch-when');
  const passed = localStorage.getItem('stopwatch-passed');
  if (passed) {
    document.body.dataset.stopwatch = 'paused';
    stopwatch.passed = Number(passed);
    stopwatch.when = Date.now() - stopwatch.passed;
    stopwatch.step(true);
  }
  else if (when) {
    stopwatch.when = Number(when);
    stopwatch.step();
  }

  stopwatch.lastlap = 0;
  const laps = localStorage.getItem('stopwatch-laps');
  if (laps) {
    for (const d of JSON.parse(laps)) {
      stopwatch.lap(d, false);
    }
  }
  stopwatch.lastlap = Number(localStorage.getItem('stopwatch-lastlap')) || 0;
}
