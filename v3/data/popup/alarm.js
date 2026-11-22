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

alarm.format = (d, time = false, zone) => {
  // the scheduled epoch rendered in the alarm's zone when it has one
  const w = schedule.wall(d.getTime(), zone);
  const day = DAYS[w.day] + ', ' + ('0' + w.d).substr(-2) + ' ' + MONTHS[w.m - 1];

  return day + (time ? ' ' + ('0' + w.hours).substr(-2) + ':' + ('0' + w.minutes).substr(-2) : '');
};

// IANA zone ids offered by the searchable picker: Intl.supportedValuesOf
// covers every supported browser, the embedded list is the fallback.
// common trading/news zones are pinned first
const PINNED = [
  'UTC',
  'America/New_York',
  'Europe/London',
  'Asia/Tokyo',
  'Asia/Hong_Kong',
  'Asia/Singapore',
  'Europe/Berlin',
  'America/Chicago',
  'Australia/Sydney'
];
const zoneList = (typeof Intl.supportedValuesOf === 'function' ?
  Intl.supportedValuesOf('timeZone') : null);
const ZONES = [...PINNED, ...((Array.isArray(zoneList) && zoneList.length ? zoneList : [
  'Africa/Cairo', 'Africa/Johannesburg', 'Africa/Lagos',
  'America/Denver', 'America/Los_Angeles', 'America/Mexico_City',
  'America/Sao_Paulo', 'America/Toronto', 'America/Vancouver',
  'Asia/Bangkok', 'Asia/Dubai', 'Asia/Jakarta', 'Asia/Karachi',
  'Asia/Kolkata', 'Asia/Kuala_Lumpur', 'Asia/Manila', 'Asia/Seoul',
  'Asia/Shanghai', 'Asia/Taipei',
  'Australia/Brisbane', 'Australia/Melbourne', 'Australia/Perth',
  'Europe/Amsterdam', 'Europe/Istanbul', 'Europe/Madrid', 'Europe/Moscow',
  'Europe/Paris', 'Europe/Rome', 'Europe/Stockholm', 'Europe/Warsaw',
  'Europe/Zurich', 'Pacific/Auckland', 'Pacific/Honolulu'
]).filter(z => PINNED.includes(z) === false))];

// display label of a zone id ("America/New_York" -> "New York")
alarm.zoneLabel = id => id.split('/').pop().replace(/_/g, ' ');

// "UTC+05:30" style rendering of a zone's current offset
alarm.zoneUTC = id => {
  const off = schedule.offset(Date.now(), id);
  const sign = off < 0 ? '-' : '+';
  const a = Math.abs(off);
  return 'UTC' + sign + ('0' + Math.floor(a / 60)).substr(-2) + ':' + ('0' + (a % 60)).substr(-2);
};

// "(14:30 local)" - the browser-local wall-clock of a zoned occurrence.
// the weekday joins in when the local date differs from the zone's
// ("(Sat 17:00 local)"), and empty when the time reads the same locally
// (nothing to convert - a New York user's New York alarm)
alarm.local = (when, zone) => {
  const w = schedule.wall(when);
  const z = schedule.wall(when, zone);
  const time = ('0' + w.hours).substr(-2) + ':' + ('0' + w.minutes).substr(-2);
  if (time === ('0' + z.hours).substr(-2) + ':' + ('0' + z.minutes).substr(-2)) {
    return '';
  }
  const day = (w.y === z.y && w.m === z.m && w.d === z.d) ? '' : DAYS[w.day] + ' ';
  return '(' + day + time + ' local)';
};

// "Sun 22 Nov, 09:30 (New York)" - the scheduled time rendered in the
// definition's zone when it has one
alarm.stamp = (when, zone) => alarm.format(new Date(when), true, zone) +
  (zone ? ' (' + alarm.zoneLabel(zone) + ')' : '');

// clear all live slots of an entry, then register the upcoming ones computed
// from the wall-clock definition (repeating single-slot modes get
// rescheduled on fire; once slots simply expire). the entry owns its
// checked/disabled view state and emits "toggle" for this model side
const scheduleEntry = (entry, on) => chrome.runtime.sendMessage({
  method: 'get-alarms'
}, alarms => {
  const jobs = [];
  // remove old alarms
  // match the ':' slot delimiter so prefix-colliding ids
  // ('alarm-0.8' vs 'alarm-0.81') cannot cross-clear each other
  alarms.filter(a => a.name.startsWith(entry.dataset.id + ':')).forEach(a => jobs.push({
    method: 'clear-alarm',
    name: a.name
  }));
  // set new alarms
  if (on) {
    const slots = schedule.slots(entry.o);
    if (slots.length === 0) {
      // a once-alarm whose explicit dates are all in the past: nothing can
      // be scheduled, so refuse the toggle instead of leaving the switch on
      // with no live slot behind it (save() blocks new definitions like
      // this; this path catches ones that went stale in storage). the
      // stale-slot clears above are still sent
      entry.passed();
    }
    else {
      slots.forEach((info, index) => jobs.push({
        method: 'set-alarm',
        info,
        name: entry.dataset.id + ':' + index
      }));
    }
  }
  chrome.runtime.sendMessage({
    method: 'batch',
    jobs
  });
});

// <alarm-entry> custom events bubbling from each entry
const container = document.querySelector('.alarm div[data-id="content"]');
container.addEventListener('toggle', ({target: entry}) => scheduleEntry(entry, entry.active));
container.addEventListener('edit', ({target: entry}) => alarm.edit(entry.o, entry.active));
container.addEventListener('remove', ({target: entry}) => {
  // clear the scheduled slots of an enabled alarm before dropping it
  if (entry.active) {
    scheduleEntry(entry, false);
  }
  entry.remove();
  chrome.storage.local.get({
    alarms: []
  }, prefs => {
    chrome.storage.local.set({
      alarms: prefs.alarms.filter(a => a.id !== entry.dataset.id)
    });
  });
});

const init = (callback = () => {}) => chrome.runtime.sendMessage({
  method: 'get-alarms'
}, alarms => chrome.storage.local.get({
  'alarms': [],
  // epochs of one-shot slots that actually rang (appended by the worker
  // on fire); entries use them to tell a rung date from a dropped one
  'fired-slots': []
}, prefs => {
  // storage is an untrusted boundary (imported preferences)
  const fired = Array.isArray(prefs['fired-slots']) ? prefs['fired-slots'] : [];
  const entries = document.querySelector('.alarm div[data-id="entries"]');

  // reuse existing entries keyed by alarm id to avoid rebuilding the
  // whole list (keeps scroll offset intact)
  const byId = new Map([...entries.querySelectorAll('alarm-entry')].map(e => [e.dataset.id, e]));
  const list = [];
  for (const o of prefs.alarms.sort((a, b) => {
    return a.time.hours * 60 + a.time.minutes - (b.time.hours * 60 + b.time.minutes);
  })) {
    let entry = byId.get(o.id);
    if (entry) {
      byId.delete(o.id);
    }
    else {
      entry = document.createElement('alarm-entry');
    }
    entry.update(o, alarms, fired);
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
  }, alarms => chrome.storage.local.get({
    'alarms': []
  }, prefs => {
    // storage is an untrusted boundary (imported preferences)
    const defs = new Map((Array.isArray(prefs.alarms) ? prefs.alarms : []).map(a => [a.id, a]));
    // zone of the definition behind a slot name, when it has a usable one
    const zoneOf = id => {
      const zone = defs.get(id)?.zone;
      return zone && schedule.zoneValid(zone) ? zone : '';
    };

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
        const label = id.startsWith('timer-') ? 'Timer' : (defs.get(id)?.name || 'Alarm');
        h1.textContent = `Snoozed ${countdown}`;
        h3.textContent = alarm.stamp(times[0], zoneOf(id)) + ' - ' + label;
      }
      else {
        // slot names are '<id>:<index>'; timers have no definition
        const zone = next.name.startsWith('alarm-') ? zoneOf(next.name.split(':')[0]) : '';
        h1.textContent = `Next ${countdown}`;
        h3.textContent = alarm.stamp(times[0], zone);
      }
    }
    else {
      if (document.querySelector('alarm-entry')) {
        h1.textContent = 'All alarms are off';
      }
      else {
        h1.textContent = 'No alarm! Use plus button to create new ones';
      }
      h3.textContent = '';
    }
  }));
};

/* edit */
{
  const edit = document.querySelector('.alarm [data-id="edit"]');
  const clock = edit.querySelector('[data-id="clock"]');
  const zoneBox = edit.querySelector('[data-id="zone-box"]');
  const zoneSelect = edit.querySelector('select[data-id="zone"]');
  const zoneSummary = edit.querySelector('[data-id="zone-summary"]');
  const zoneNow = edit.querySelector('[data-id="zone-now"]');
  const snooze = edit.querySelector('[data-id="snooze"]');
  const name = edit.querySelector('[data-id="name"]');
  const datesBox = edit.querySelector('[data-id="dates"]');
  const newDate = edit.querySelector('[data-id="new-date"]');
  const monthDay = edit.querySelector('[data-id="month-day"]');
  const yearMonth = edit.querySelector('[data-id="yearly-month"]');
  const yearDay = edit.querySelector('[data-id="yearly-day"]');
  const pills = [...edit.querySelectorAll('[data-id="days"] input[type=checkbox]')];
  const radios = [...edit.querySelectorAll('[data-id="repeat"] input[type=radio]')];

  // options of the zone picker: the local default, the pinned common
  // zones, then one optgroup per region. labels start as bare city names;
  // their current UTC offsets are appended right after first paint so
  // building ~400 labels cannot delay the popup
  {
    const add = (parent, value) => {
      const option = document.createElement('option');
      option.value = value;
      option.textContent = alarm.zoneLabel(value);
      parent.append(option);
      return option;
    };
    const local = add(zoneSelect, '');
    local.textContent = 'Local time';
    const common = document.createElement('optgroup');
    common.label = 'Common';
    zoneSelect.append(common);
    for (const id of PINNED) {
      add(common, id);
    }
    let group = null;
    let region = '';
    for (const id of ZONES) {
      if (PINNED.includes(id)) {
        continue;
      }
      const [r] = id.split('/');
      if (r !== region) {
        region = r;
        group = document.createElement('optgroup');
        group.label = r;
        zoneSelect.append(group);
      }
      add(group, id);
    }
    setTimeout(() => {
      for (const option of zoneSelect.options) {
        if (option.value) {
          option.textContent = alarm.zoneLabel(option.value) + ' (' + alarm.zoneUTC(option.value) + ')';
        }
      }
    }, 0);
  }

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

  const todayISO = zone => {
    // "today" of the alarm's zone; its date can differ from the local one
    const w = schedule.wall(Date.now(), zone);
    return schedule.toISO(w.y, w.m, w.d);
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
    // a chosen zone is part of the definition; the local default is
    // simply not stored, so legacy definitions stay byte-identical
    if (zoneSelect.value) {
      o.zone = zoneSelect.value;
    }
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

  const onchange = () => {
    // the once-alarm schedulability error refers to the draft state, which
    // just changed; save() re-evaluates and re-raises it when needed
    clock.setCustomValidity('');
    const o = readDraft();
    const zone = o.zone || '';
    const label = zone ? ' (' + alarm.zoneLabel(zone) + ')' : '';
    // the summary states the zone the clock reads in even while the
    // picker is collapsed; the live wall-clock under it lets the user
    // sanity-check a market/news time before saving
    zoneSummary.textContent = zone ? alarm.zoneLabel(zone) : 'Local time';
    if (zone) {
      const w = schedule.wall(Date.now(), zone);
      zoneNow.textContent = 'Now: ' + ('0' + w.hours).substr(-2) + ':' + ('0' + w.minutes).substr(-2) +
        ' in ' + alarm.zoneLabel(zone) + ' (' + alarm.zoneUTC(zone) + ')';
    }
    else {
      zoneNow.textContent = '';
    }
    const current = document.querySelector('.alarm [data-id=current]');
    const days = o.days || [];
    if (o.repeat === 'daily') {
      current.textContent = 'Every day' + label;
    }
    else if (o.repeat === 'weekly') {
      // an incomplete day selection stays in the mode and is guided here;
      // save() blocks it with native feedback instead of switching modes
      const summary = days.length === 0 ? 'Every week - select a day' :
        (days.length === 7 ? 'Every day' : 'Every week - ' + days.map(d => DAYS[Number(d)]).join(', '));
      current.textContent = summary + label;
    }
    else if (o.repeat === 'monthly') {
      current.textContent = 'Monthly - ' + (o.day === 'last' ? 'the last day of the month' : ordinal(o.day)) + label;
    }
    else if (o.repeat === 'yearly') {
      current.textContent = 'Yearly - ' + o.date.d + ' ' + MONTHS[o.date.m - 1] + label;
    }
    else {
      const when = schedule.next(o);
      if (when) {
        // "today"/"tomorrow" are judged in the alarm's zone, whose date
        // can differ from the browser's
        const w = schedule.wall(when, zone);
        const now = schedule.wall(Date.now(), zone);
        const tomorrow = schedule.wall(Date.now() + 24 * 60 * 60 * 1000, zone);
        const same = (a, b) => a.y === b.y && a.m === b.m && a.d === b.d;
        current.textContent = (same(w, now) ? 'Today - ' : same(w, tomorrow) ? 'Tomorrow - ' : 'Once - ') + alarm.stamp(when, zone);
      }
      else {
        // every explicit date of this once-draft is already in the past,
        // so nothing can be scheduled; save() blocks it with native
        // feedback as well
        current.textContent = 'Already passed - pick a future time';
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
  // (the boundary is judged in the alarm's zone)
  newDate.addEventListener('change', () => {
    const parsed = schedule.parseISO(newDate.value);
    const zone = zoneSelect.value || '';
    if (parsed &&
        schedule.resolve(parsed.y, parsed.m, parsed.d, {hours: 23, minutes: 59}, zone) >= Date.now() &&
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
    if (o.repeat === 'once' && schedule.slots(o).length === 0) {
      // every explicit date of this once-alarm is already in the past, so
      // nothing could ever be scheduled; native feedback is anchored at the
      // clock (a future time, or dropping the stale date chip, clears it)
      clock.setCustomValidity('Time already passed - pick a future time or remove the date');
      clock.reportValidity();
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
          document.querySelector(`.alarm alarm-entry[data-id="${id}"]`)?.restart();
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
    // the picker opens only for alarms that actually carry a usable zone.
    // an imported id outside the built list gets its own option so saving
    // cannot drop a working zone; an id the runtime rejects (already
    // firing locally) normalizes to local on save
    const zone = o.zone && schedule.zoneValid(o.zone) ? o.zone : '';
    if (zone && [...zoneSelect.options].every(option => option.value !== zone)) {
      const option = document.createElement('option');
      option.value = zone;
      option.textContent = alarm.zoneLabel(zone) + ' (' + alarm.zoneUTC(zone) + ')';
      zoneSelect.append(option);
    }
    zoneSelect.value = zone;
    zoneBox.open = zone !== '';
    const nowW = schedule.wall(Date.now(), zone);
    monthDay.value = o.day === 'last' ? 'last' : String(o.day ?? nowW.d);
    yearMonth.value = String(o.date?.m ?? nowW.m);
    yearDay.value = String(o.date?.d ?? nowW.d);
    newDate.min = todayISO(zone);
    newDate.value = '';
    renderDates();
    name.value = o.name || '';

    edit.dataset.assign = o.id;
    edit.dataset.restart = restart;

    document.body.dataset.alarm = 'edit';

    onchange();
  };
}

// update toast and entries on "alarms-storage" change
chrome.storage.onChanged.addListener(ps => {
  if (ps['alarms-storage']) {
    alarm.toast();
    init();
  }
});
