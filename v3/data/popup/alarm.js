'use strict';

const alarm = {};
window.alarm = alarm;

const MONTHS = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'
];
const DAYS = {
  0: 'Sun',
  1: 'Mon',
  2: 'Tue',
  3: 'Wed',
  4: 'Thu',
  5: 'Fri',
  6: 'Sat'
};
const PILL = {
  0: 'Su',
  1: 'M',
  2: 'Tu',
  3: 'W',
  4: 'Th',
  5: 'F',
  6: 'Sa'
};

const ordinal = n => {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
};

alarm.format = (d, time = false) => {
  const day = DAYS[d.getDay()] + ', ' + ('0' + d.getDate()).substr(-2) + ' ' + MONTHS[d.getMonth()];

  return day + (time ? ' ' + ('0' + d.getHours()).substr(-2) + ':' + ('0' + d.getMinutes()).substr(-2) : '');
};

// enable/disable an entry: clear all its slots, then register the upcoming
// ones computed from the wall-clock definition (repeating single-slot modes
// get rescheduled on fire; once slots simply expire)
document.querySelector('.alarm div[data-id="content"]').addEventListener('change', ({target}) => {
  const entry = target.closest('.entry');
  if (entry) {
    const jobs = [];
    entry.setAttribute('disabled', target.checked ? false : true);

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
        schedule.slots(entry.o).forEach((info, index) => jobs.push({
          method: 'set-alarm',
          info,
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

alarm.update = (entry, raw, alarms) => {
  const o = entry.o = schedule.normalize(raw);
  const {id, time, name} = o;
  // time
  entry.querySelector('[data-id="time"]').textContent =
    ('0' + time.hours).substr(-2) + ':' +
    ('0' + time.minutes).substr(-2);
  // upcoming occurrence(s)
  const slots = schedule.slots(o);
  const date = entry.querySelector('[data-id="date"]');
  const active = alarms.some(a => a.name.startsWith(id));
  // scheduled epochs of this alarm's live slots; a fired one-shot ("once")
  // slot vanishes from chrome.alarms - render that weekday/date struck
  // through. an OFF alarm has no slots either (cleared, not fired), so it
  // renders without strikes
  const times = new Set(
    alarms.filter(a => a.name.startsWith(id))
      .map(a => a.scheduledTime)
  );
  const pending = new Set(
    [...times].map(t => new Date(t).getDay())
  );
  date.textContent = '';
  date.classList.remove('range');

  const span = (text, fired = false) => {
    const span = document.createElement('span');
    span.textContent = text;
    if (fired) {
      span.classList.add('fired');
    }
    date.appendChild(span);
  };

  if (o.repeat === 'weekly') {
    date.classList.add('range');
    for (const d of (o.days || [])) {
      span(PILL[Number(d)]);
    }
  }
  else if (o.repeat === 'once' && ((o.dates?.length ?? 0) + (o.days?.length ?? 0) > 0)) {
    date.classList.add('range');
    for (const {y, m, d} of (o.dates || [])) {
      const when = schedule.resolve(Number(y), Number(m), Number(d), time);
      span(d + ' ' + MONTHS[Number(m) - 1], active && times.has(when) === false);
    }
    for (const d of (o.days || [])) {
      span(PILL[Number(d)], active && pending.has(Number(d)) === false);
    }
  }
  else if (o.repeat === 'daily') {
    date.classList.add('range');
    span('Every day');
  }
  else if (o.repeat === 'monthly') {
    date.classList.add('range');
    span(o.day === 'last' ? 'Last day' : ordinal(Number(o.day)));
  }
  else if (o.repeat === 'yearly' && o.date) {
    date.classList.add('range');
    span(Number(o.date.d) + ' ' + MONTHS[Number(o.date.m) - 1]);
  }
  else {
    // no explicit schedule info; show the next computed occurrence
    date.textContent = slots.length ? alarm.format(new Date(slots[0].when)) : '';
  }

  entry.dataset.id = id;
  entry.setAttribute('disabled', active === false);
  entry.querySelector('input[type="checkbox"]').checked = active;
  entry.title = entry.querySelector('[data-id="description"]').textContent = name || '';

  entry.querySelector('[data-id="once"]').textContent = o.repeat === 'once' ? 'once' : '';
};

const init = (callback = () => {}) => chrome.runtime.sendMessage({
  method: 'get-alarms'
}, alarms => chrome.storage.local.get({
  'alarms': []
}, prefs => {
  const t = document.querySelector('.alarm template');
  const entries = document.querySelector('.alarm div[data-id="entries"]');

  // reuse existing entries keyed by alarm id to avoid rebuilding the
  // whole list (keeps scroll offset intact)
  const byId = new Map([...entries.querySelectorAll('.entry')].map(e => [e.dataset.id, e]));
  const list = [];
  for (const o of prefs.alarms.sort((a, b) => {
    return a.time.hours * 60 + a.time.minutes - (b.time.hours * 60 + b.time.minutes);
  })) {
    let entry = byId.get(o.id);
    if (entry) {
      byId.delete(o.id);
    }
    else {
      entry = document.importNode(t.content, true).querySelector('.entry');
    }
    alarm.update(entry, o, alarms);
    list.push(entry);
  }
  // remove entries whose alarm is gone
  for (const entry of byId.values()) {
    entry.remove();
  }
  // reorder; only move nodes that are out of position
  list.forEach((entry, index) => {
    if (entries.children[index] !== entry) {
      entries.insertBefore(entry, entries.children[index] || null);
    }
  });
  // unique snoozes badge
  const uniques = new Set(alarms.filter(a => a.name.startsWith('audio-')).map(o => o.name.split('/')[0]));
  const snoozes = uniques.size;
  document.querySelector('#snoozes [data-id="badge"]').textContent = snoozes || '';
  document.getElementById('kill-snoozes').disabled = snoozes === 0;
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
  chrome.runtime.sendMessage({
    method: 'get-alarms'
  }, alarms => {
    const times = alarms.map(o => o.scheduledTime);

    const h1 = document.querySelector('.alarm [data-id="toast"] h1');
    const h3 = document.querySelector('.alarm [data-id="toast"] h3');

    if (times.length) {
      times.sort();
      const time = Date.now();
      const delays = times.map(d => d - time);
      const o = alarm.ms2time(delays[0]);
      const countdown = `in ${o.days ? o.days + ' days ' : ''}${o.hours} hours ${o.minutes} minutes`;
      const next = alarms.find(a => a.scheduledTime === times[0]);

      if (next.name.startsWith('audio-')) {
        const id = next.name.replace('audio-', '').split('/')[0];
        chrome.storage.local.get({
          'alarms': []
        }, prefs => {
          const source = prefs.alarms.filter(a => a.id === id).shift();
          const label = id.startsWith('timer-') ? 'Timer' : (source?.name || 'Alarm');
          h1.textContent = `Snoozed ${countdown}`;
          h3.textContent = alarm.format(new Date(times[0]), true) + ' - ' + label;
        });
      }
      else {
        h1.textContent = `Next ${countdown}`;
        h3.textContent = alarm.format(new Date(times[0]), true);
      }
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
  });
};

/* edit */
{
  const edit = document.querySelector('.alarm [data-id="edit"]');
  const clock = edit.querySelector('[data-id="clock"]');
  const snooze = edit.querySelector('[data-id="snooze"]');
  const name = edit.querySelector('[data-id="name"]');
  const datesBox = edit.querySelector('[data-id="dates"]');
  const newDate = edit.querySelector('[data-id="new-date"]');
  const monthDay = edit.querySelector('[data-id="month-day"]');
  const yearMonth = edit.querySelector('[data-id="yearly-month"]');
  const yearDay = edit.querySelector('[data-id="yearly-day"]');
  const pills = [...edit.querySelectorAll('[data-id="days"] input[type=checkbox]')];
  const radios = [...edit.querySelectorAll('[data-id="repeat"] input[type=radio]')];

  // working state of the once-mode date chips
  const draft = {
    dates: []
  };

  // monthly select: days 1-31 plus the "last day of the month" entry
  for (let day = 1; day <= 31; day += 1) {
    const option = document.createElement('option');
    option.value = option.textContent = day;
    monthDay.append(option);
  }
  {
    const option = document.createElement('option');
    option.value = 'last';
    option.textContent = 'Last day';
    monthDay.append(option);
  }
  // yearly repeats keep the raw month-day anchor (e.g. Feb 29); shorter
  // months and non-leap years clamp at scheduling time, not here
  MONTHS.forEach((month, index) => {
    const option = document.createElement('option');
    option.value = index + 1;
    option.textContent = month;
    yearMonth.append(option);
  });
  for (let day = 1; day <= 31; day += 1) {
    const option = document.createElement('option');
    option.value = option.textContent = day;
    yearDay.append(option);
  }

  const todayISO = () => {
    const d = new Date();
    return schedule.toISO(d.getFullYear(), d.getMonth() + 1, d.getDate());
  };

  const setMode = repeat => {
    edit.dataset.repeat = repeat;
    const radio = radios.find(r => r.value === repeat);
    if (radio) {
      radio.checked = true;
    }
  };

  const renderDates = () => {
    datesBox.textContent = '';
    draft.dates.forEach(({y, m, d}, index) => {
      const chip = document.createElement('span');
      chip.className = 'chip';
      const label = document.createElement('span');
      label.textContent = d + ' ' + MONTHS[m - 1];
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.dataset.command = 'remove-date';
      remove.dataset.index = index;
      chip.append(label, remove);
      datesBox.append(chip);
    });
  };

  const readDraft = () => {
    const [hours, minutes] = (clock.value || '00:00').split(':').map(Number);
    const repeat = edit.dataset.repeat;
    const o = {
      time: {
        hours: Number.isFinite(hours) ? hours : 0,
        minutes: Number.isFinite(minutes) ? minutes : 0
      },
      repeat,
      snooze: snooze.checked,
      name: name.value
    };
    if (repeat === 'weekly' || repeat === 'once') {
      o.days = pills.filter(e => e.checked).map(e => Number(e.value));
    }
    if (repeat === 'once') {
      o.dates = draft.dates.slice();
    }
    if (repeat === 'monthly') {
      o.day = monthDay.value === 'last' ? 'last' : Number(monthDay.value);
    }
    if (repeat === 'yearly') {
      o.date = {
        m: Number(yearMonth.value),
        d: Number(yearDay.value)
      };
    }
    return o;
  };

  const sameDay = (a, b) => a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() && a.getDate() === b.getDate();

  const onchange = () => {
    const o = readDraft();
    const current = document.querySelector('.alarm [data-id=current]');
    const days = o.days || [];
    if (o.repeat === 'daily') {
      current.textContent = 'Every day';
    }
    else if (o.repeat === 'weekly') {
      // an incomplete day selection stays in the mode and is guided here;
      // save() blocks it with native feedback instead of switching modes
      current.textContent = days.length === 0 ? 'Every week - select a day' :
        (days.length === 7 ? 'Every day' : 'Every week - ' + days.map(d => DAYS[Number(d)]).join(', '));
    }
    else if (o.repeat === 'monthly') {
      current.textContent = 'Monthly - ' + (o.day === 'last' ? 'the last day of the month' : ordinal(o.day));
    }
    else if (o.repeat === 'yearly') {
      current.textContent = 'Yearly - ' + o.date.d + ' ' + MONTHS[o.date.m - 1];
    }
    else {
      const when = schedule.next(o);
      if (when) {
        const d = new Date(when);
        const n = new Date();
        const t = new Date(n.getTime() + 24 * 60 * 60 * 1000);
        current.textContent = (sameDay(d, n) ? 'Today - ' : sameDay(d, t) ? 'Tomorrow - ' : 'Once - ') + alarm.format(d);
      }
      else {
        current.textContent = 'Once';
      }
    }
  };

  radios.forEach(radio => radio.addEventListener('change', () => {
    setMode(radio.value);
    onchange();
  }));
  // clear the day-selection error as soon as any pill changes
  pills.forEach(pill => pill.addEventListener('change', () => pills[0].setCustomValidity('')));
  edit.addEventListener('change', ({target}) => {
    if (target.type !== 'radio') {
      onchange();
    }
  });
  edit.addEventListener('input', onchange);

  // picking a date adds it as a chip; only future dates can be scheduled
  newDate.addEventListener('change', () => {
    const parsed = schedule.parseISO(newDate.value);
    if (parsed &&
        schedule.resolve(parsed.y, parsed.m, parsed.d, {hours: 23, minutes: 59}) >= Date.now() &&
        draft.dates.some(o => o.y === parsed.y && o.m === parsed.m && o.d === parsed.d) === false) {
      draft.dates.push(parsed);
      draft.dates.sort((a, b) => (a.y * 10000 + a.m * 100 + a.d) - (b.y * 10000 + b.m * 100 + b.d));
      renderDates();
    }
    newDate.value = '';
    onchange();
  });

  alarm['remove-date'] = target => {
    const index = Number(target.dataset.index);
    if (draft.dates[index]) {
      draft.dates.splice(index, 1);
      renderDates();
      onchange();
    }
  };

  alarm.save = () => chrome.storage.local.get({
    alarms: []
  }, prefs => {
    const id = edit.dataset.assign;
    const restart = edit.dataset.restart === 'true';
    if (clock.value === '') {
      clock.reportValidity();
      return;
    }
    const o = readDraft();
    if (o.repeat === 'weekly' && (o.days?.length ?? 0) === 0) {
      // a weekly alarm needs at least one weekday; native feedback is
      // anchored at the day pills
      pills[0].setCustomValidity('Select at least one day');
      pills[0].reportValidity();
      return;
    }
    const a = {
      id,
      ...o
    };

    const ids = prefs.alarms.map(a => a.id);
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
    dates: [],
    time: (() => {
      const d = new Date(Date.now() + 30 * 60 * 1000);
      return {
        hours: d.getHours(),
        minutes: d.getMinutes()
      };
    })(),
    snooze: false,
    repeat: 'once',
    id: 'alarm-' + Math.random(),
    name: ''
  }, restart = false) => {
    o = schedule.normalize(o);
    draft.dates = (o.dates || []).map(({y, m, d}) => ({y, m, d}));
    setMode(o.repeat);
    clock.value = ('0' + o.time.hours).substr(-2) + ':' + ('0' + o.time.minutes).substr(-2);
    pills.forEach(e => {
      e.checked = (o.days || []).indexOf(Number(e.value)) !== -1;
    });
    snooze.checked = o.snooze;
    monthDay.value = o.day === 'last' ? 'last' : String(o.day ?? new Date().getDate());
    yearMonth.value = String(o.date?.m ?? new Date().getMonth() + 1);
    yearDay.value = String(o.date?.d ?? new Date().getDate());
    newDate.min = todayISO();
    newDate.value = '';
    renderDates();
    name.value = o.name || '';

    edit.dataset.assign = o.id;
    edit.dataset.restart = restart;

    document.body.dataset.alarm = 'edit';

    onchange();
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
      });
    });
  }
};

// edit from entry
document.querySelector('.alarm div[data-id="content"]').addEventListener('dblclick', ({target}) => {
  const entry = target.closest('.entry');
  if (entry && target.classList.contains('switch') === false) {
    const active = entry.querySelector('.switch').checked;
    alarm.edit(entry.o, active);
  }
});

// update toast and entries on "alarms-storage" change
chrome.storage.onChanged.addListener(ps => {
  if (ps['alarms-storage']) {
    alarm.toast();
    init();
  }
});
