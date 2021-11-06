'use strict';

const alarm = {};
window.alarm = alarm;

alarm.format = (d, time = false) => {
  const day = ({
    0: 'Sun',
    1: 'Mon',
    2: 'Tue',
    3: 'Wen',
    4: 'Thu',
    5: 'Fri',
    6: 'Sat'
  })[d.getDay()] + ', ' + ('0' + d.getDate()).substr(-2) + ' ' + ({
    0: 'Jan',
    1: 'Feb',
    2: 'Mar',
    3: 'Apr',
    4: 'May',
    5: 'Jun',
    6: 'Jul',
    7: 'Aug',
    8: 'Sep',
    9: 'Oct',
    10: 'Nov',
    11: 'Dec'
  })[d.getMonth()];

  return day + (time ? ' ' + ('0' + d.getHours()).substr(-2) + ':' + ('0' + d.getMinutes()).substr(-2) : '');
};

document.querySelector('.alarm div[data-id="content"]').addEventListener('change', ({target}) => {
  const entry = target.closest('.entry');
  if (entry) {
    const jobs = [];
    entry.setAttribute('disabled', target.checked ? false : true);
    alarm.toast();
    chrome.runtime.sendMessage({
      method: 'get-alarms'
    }, alarms => {
      // remove old alarms
      alarms.filter(a => a.name.startsWith(entry.dataset.id)).forEach(a => jobs.push({
        method: 'clear-alarm',
        name: a.name
      }));
      // set new alarms
      if (target.checked) {
        let periodInMinutes = undefined;
        if (entry.querySelector('[data-id=once]').textContent === '') {
          periodInMinutes = entry.querySelector('[data-id=date]').classList.contains('range') ? 7 * 24 * 60 : undefined;
        }

        entry.times.forEach((when, index) => jobs.push({
          method: 'set-alarm',
          info: {
            when,
            periodInMinutes
          },
          name: entry.dataset.id + ':' + index
        }));
      }
      chrome.runtime.sendMessage({
        method: 'batch',
        jobs
      });
    });
  }
});

alarm.convert = (time, ds) => {
  const d = new Date(); // 0 - 6 Sunday is 0, Monday is 1, and so on.
  d.setSeconds(0);
  const day = d.getDay();
  const days = [...ds]; // clone
  if (days.length === 0) {
    days.push(d.getDay());
  }
  return days.map(a => (a - day)).map(n => {
    const o = new Date();
    o.setDate(d.getDate() + n);
    o.setHours(time.hours, time.minutes, 0);
    if (o.getTime() < Date.now()) {
      o.setDate(o.getDate() + 7);
    }
    return o.getTime();
  }).filter((n, i, l) => l.indexOf(n) === i).sort();
};

const init = (callback = () => {}) => chrome.runtime.sendMessage({
  method: 'get-alarms'
}, alarms => chrome.storage.local.get({
  'alarms': []
}, prefs => {
  const t = document.querySelector('.alarm template');
  const entries = document.querySelector('.alarm div[data-id="entries"]');

  for (const o of prefs.alarms.sort((a, b) => {
    return a.time.hours * 60 + a.time.minutes - (b.time.hours * 60 + b.time.minutes);
  })) {
    const {id, time, days} = o;
    const clone = document.importNode(t.content, true);
    // time
    clone.querySelector('[data-id="time"]').textContent =
      ('0' + time.hours).substr(-2) + ':' +
      ('0' + time.minutes).substr(-2);
    // next occurance
    const times = alarm.convert(time, days);
    const date = clone.querySelector('[data-id="date"]');
    if (days.length) {
      const map = {
        0: 'S',
        1: 'M',
        2: 'T',
        3: 'W',
        4: 'T',
        5: 'F',
        6: 'S'
      };
      date.textContent = days.map(d => map[d]).join(' ');
      date.classList.add('range');
    }
    else {
      date.textContent = alarm.format(new Date(times[0]));
    }
    const entry = clone.querySelector('.entry');
    entry.times = times;
    entry.o = o;
    entry.dataset.id = id;
    const active = alarms.some(a => a.name.startsWith(id));
    entry.setAttribute('disabled', active === false);
    clone.querySelector('input[type="checkbox"]').checked = active;

    entry.querySelector('[data-id="once"]').textContent = o.once ? 'once' : '';
    entries.appendChild(clone);
  }
  alarm.toast();
  callback();
}));
init();

alarm.ms2time = duration => ({
  seconds: Math.floor((duration / 1000) % 60),
  minutes: Math.floor((duration / (1000 * 60)) % 60),
  hours: Math.floor((duration / (1000 * 60 * 60)) % 24),
  days: Math.floor((duration / (1000 * 60 * 60 * 24)))
});

alarm.toast = () => {
  const h1 = document.querySelector('.alarm [data-id="toast"] h1');
  const h3 = document.querySelector('.alarm [data-id="toast"] h3');
  const times = [];
  [...document.querySelectorAll('.alarm .entry[disabled=false]')].forEach(entry => {
    times.push(...entry.times);
  });
  if (times.length) {
    times.sort();
    const time = Date.now();
    const delays = times.map(d => d - time);
    const o = alarm.ms2time(delays[0]);
    h1.textContent = `Next in ${o.days ? o.days + ' days ' : ''}${o.hours} hours ${o.minutes} minutes`;
    h3.textContent = alarm.format(new Date(times[0]), true);
  }
  else {
    if (document.querySelector('.entry')) {
      h1.textContent = 'All alarms are off';
    }
    else {
      h1.textContent = 'No alarm! Use plus button to create new ones';
    }
    h3.textContent = '';
  }
};

/* edit */
{
  const hours = document.querySelector('.alarm [data-id="edit"] [data-id="hours"]');
  const minutes = document.querySelector('.alarm [data-id="edit"] [data-id="minutes"]');

  const edit = document.querySelector('.alarm [data-id="edit"]');
  const onchange = () => {
    // updating toast
    const current = document.querySelector('.alarm [data-id=current]');
    const days = [...document.querySelectorAll('.alarm [data-id="edit"] [data-id="days"] input[type=checkbox]')]
      .filter(e => e.checked);
    if (days.length === 7) {
      current.textContent = 'Every day';
    }
    else if (days.length > 1) {
      const map = {
        0: 'Sun',
        1: 'Mon',
        2: 'Tue',
        3: 'Wen',
        4: 'Thu',
        5: 'Fri',
        6: 'Sat'
      };
      current.textContent = days.map(e => map[e.value]).join(', ');
    }
    else {
      const times = alarm.convert({
        hours: Number(hours.value),
        minutes: Number(minutes.value)
      }, days.map(e => e.value));
      const time = times.shift();
      const n = new Date();
      const d = new Date(time);
      const t = new Date(n.getTime() + 24 * 60 * 60 * 1000);
      if (d.getDate() === n.getDate()) {
        current.textContent = 'Today - ' + alarm.format(d);
      }
      else if (d.getDate() === t.getDate()) {
        current.textContent = 'Tomorrow - ' + alarm.format(d);
      }
      else {
        current.textContent = alarm.format(d);
      }
    }
    if (days.length === 0) {
      document.querySelector('.alarm [data-id="edit"] [data-id="once"]').checked = true;
    }
  };
  edit.addEventListener('change', onchange);
  edit.addEventListener('input', onchange);

  alarm.save = () => chrome.storage.local.get({
    alarms: []
  }, prefs => {
    const id = document.querySelector('.alarm [data-id="edit"]').dataset.assign;
    const restart = document.querySelector('.alarm [data-id="edit"]').dataset.restart === 'true';
    const ids = prefs.alarms.map(a => a.id);
    const a = {
      id,
      days: [...document.querySelectorAll('.alarm [data-id="edit"] [data-id="days"] input[type=checkbox]')]
        .filter(e => e.checked).map(e => Number(e.value)),
      time: {
        hours: Math.min(23, Math.max(0, Number(hours.value))),
        minutes: Math.min(59, Math.max(0, Number(minutes.value)))
      },
      snooze: document.querySelector('.alarm [data-id="edit"] [data-id="snooze"]').checked,
      once: document.querySelector('.alarm [data-id="edit"] [data-id="once"]').checked,
      name: document.querySelector('.alarm [data-id="edit"] [data-id="name"]').value
    };
    const index = ids.indexOf(id);
    if (index === -1) {
      prefs.alarms.push(a);
    }
    else {
      prefs.alarms[index] = a;
    }
    chrome.storage.local.set({
      alarms: prefs.alarms
    }, () => {
      document.querySelector('.alarm div[data-id="entries"]').textContent = '';
      init(() => {
        if (restart) {
          const input = document.querySelector(`.alarm .entry[data-id="${id}"] input[type=checkbox]`);
          input.dispatchEvent(new Event('change', {
            bubbles: true
          }));
        }
      });
      document.body.dataset.alarm = 'view';
    });
  });
  alarm.edit = (o = {
    days: [],
    time: (() => {
      const d = new Date(Date.now() + 30 * 60 * 1000);
      return {
        hours: d.getHours(),
        minutes: d.getMinutes()
      };
    })(),
    snooze: false,
    once: true,
    id: 'alarm-' + Math.random(),
    name: ''
  }, restart = false) => {
    [...document.querySelectorAll('.alarm [data-id="edit"] [data-id="days"] input[type=checkbox]')].forEach(e => {
      e.checked = o.days.indexOf(Number(e.value)) !== -1;
    });
    hours.value = ('0' + o.time.hours).substr(-2);
    minutes.value = ('0' + o.time.minutes).substr(-2);
    document.querySelector('.alarm [data-id="edit"] [data-id="snooze"]').checked = o.snooze;
    document.querySelector('.alarm [data-id="edit"] [data-id="once"]').checked = o.once;
    document.querySelector('.alarm [data-id="edit"]').dataset.assign = o.id;
    document.querySelector('.alarm [data-id="edit"]').dataset.restart = restart;
    document.querySelector('.alarm [data-id="edit"] [data-id="name"]').value = o.name || '';

    document.body.dataset.alarm = 'edit';
  };
}

alarm.remove = target => {
  const entry = target.closest('.entry');
  if (entry) {
    // remove alarms;
    const input = entry.querySelector('input:checked');
    if (input) {
      input.click();
    }
    entry.remove();
    chrome.storage.local.get({
      alarms: []
    }, prefs => {
      chrome.storage.local.set({
        alarms: prefs.alarms.filter(a => a.id.startsWith(entry.dataset.id) === false)
      }, alarm.toast);
    });
  }
};

// edit from entry
document.querySelector('.alarm div[data-id="content"]').addEventListener('dblclick', ({target}) => {
  const entry = target.closest('.entry');
  if (entry) {
    const active = entry.querySelector('.switch').checked;
    alarm.edit(entry.o, active);
  }
});
