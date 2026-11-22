/* globals schedule, alarm, MONTHS, PILL, ordinal */
'use strict';

// <alarm-entry>: one alarm in the list view. The markup, styles, and
// interactions live in an open shadow root; the page drives the view through
// update(raw, alarms, fired) / restart() / passed() and listens to the
// bubbling custom events:
//   toggle - the enable/disable switch changed (scheduling lives in alarm.js)
//   edit   - the edit button was clicked
//   remove - the remove button was clicked

// hint appended to the title of a once-alarm whose dates are all in the
// past (no schedulable occurrence left)
const PASSED = 'time already passed - edit to pick a future time';

const template = document.createElement('template');
template.innerHTML = `
  <span class="large" data-id="time">00:00</span>
  <span class="small" data-id="description"></span>
  <span class="small" data-id="once"></span>
  <span class="small" data-id="date"></span>
  <input type="checkbox" class="switch">
  <input type="button" data-command="edit" title="Edit alarm" aria-label="Edit alarm">
  <input type="button" data-command="remove" title="Remove alarm" aria-label="Remove alarm">
`;

// shared by every instance; theming flows in through the inherited custom
// properties (var(--bg-dark-color), ...) defined on the popup page
const sheet = new CSSStyleSheet();
sheet.replaceSync(`
  :host {
    display: grid;
    grid-template-columns: auto 1fr auto auto;
    grid-template-areas:
      "time description switch switch"
      "once  date        edit   remove";
    align-items: center;
    column-gap: 10px;
    row-gap: 5px;
    padding: 10px 20px;
    background-color: var(--bg-dark-color);
  }
  :host([hidden]) {
    display: none;
  }
  :host(:not(:last-child)) {
    margin-bottom: 10px;
  }
  :host([disabled=true]) {
    opacity: 0.5;
  }
  :host([disabled=false]) [data-id="description"] {
    color: var(--color-dark);
  }
  .large {
    font-size: var(--font-large);
  }
  .small {
    font-size: var(--font-small);
  }
  [data-id="time"] {
    grid-area: time;
    font-weight: 300;
    text-align: left;
  }
  [data-id="description"] {
    grid-area: description;
    text-align: left;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    min-width: 0;
  }
  [data-id="once"] {
    grid-area: once;
    justify-self: start;
    background-color: var(--bg-pink-color);
    padding: 0 10px;
  }
  [data-id="once"]:empty {
    display: none;
  }
  [data-id="date"] {
    grid-area: date;
    min-width: 0;
  }
  [data-id="date"].range {
    color: var(--color-pink);
    display: inline-flex;
    flex-wrap: wrap;
    gap: 5px;
  }
  [data-id="date"] .fired {
    text-decoration: line-through;
    opacity: 0.4;
  }
  [data-id="date"] .passed {
    text-decoration: underline dashed;
    opacity: 0.5;
  }
  /* the switch is painted on the input itself: Firefox renders no ::after
     on input elements, so the graphic must not live in a pseudo-element */
  input[type="checkbox"].switch {
    grid-area: switch;
    justify-self: end;
    appearance: none;
    width: 32px;
    height: 28px;
    background: url('icons/switch-off.svg') center center no-repeat;
    background-size: 32px;
    cursor: pointer;
  }
  input[type="checkbox"].switch:checked {
    background-image: url('icons/switch-on.svg');
  }
  input[type="checkbox"].switch:focus-visible {
    outline: 2px solid var(--color);
    outline-offset: 1px;
  }
  input[type="button"] {
    appearance: none;
    width: 16px;
    height: 16px;
    padding: 0;
    border: none;
    outline: none;
    border-radius: 20px;
    cursor: pointer;
  }
  input[type="button"]:focus-visible {
    outline: 2px solid var(--color);
    outline-offset: 1px;
  }
  [data-command="edit"] {
    grid-area: edit;
    background: url(icons/edit.svg) center center no-repeat;
    background-size: 12px;
    filter: invert(1);
  }
  [data-command="remove"] {
    grid-area: remove;
    background: url(icons/close.svg) center center no-repeat;
    background-size: 19px;
    filter: invert(1);
  }
`);

class AlarmEntry extends HTMLElement {
  #o;
  #switch;
  #time;
  #description;
  #once;
  #date;

  constructor() {
    super();
    this.attachShadow({mode: 'open', delegatesFocus: true});
    this.shadowRoot.adoptedStyleSheets = [sheet];
    this.shadowRoot.append(template.content.cloneNode(true));

    this.#switch = this.shadowRoot.querySelector('input.switch');
    this.#time = this.shadowRoot.querySelector('[data-id="time"]');
    this.#description = this.shadowRoot.querySelector('[data-id="description"]');
    this.#once = this.shadowRoot.querySelector('[data-id="once"]');
    this.#date = this.shadowRoot.querySelector('[data-id="date"]');

    // the checked/disabled view state is owned here; alarm.js reacts to the
    // "toggle" event and re-registers the chrome.alarms slots
    this.#switch.addEventListener('change', () => {
      this.#sync();
      this.dispatchEvent(new CustomEvent('toggle', {bubbles: true}));
    });
    this.shadowRoot.querySelector('[data-command="edit"]').addEventListener('click', () => {
      this.dispatchEvent(new CustomEvent('edit', {bubbles: true}));
    });
    this.shadowRoot.querySelector('[data-command="remove"]').addEventListener('click', () => {
      this.dispatchEvent(new CustomEvent('remove', {bubbles: true}));
    });
  }

  get o() {
    return this.#o;
  }

  get active() {
    return this.#switch.checked;
  }

  // reflect the switch state as the disabled attribute (drives :host opacity)
  #sync() {
    this.setAttribute('disabled', this.#switch.checked ? 'false' : 'true');
  }

  update(raw, alarms, fired = []) {
    const o = this.#o = schedule.normalize(raw);
    const {id, time, name} = o;
    // time
    this.#time.textContent =
      ('0' + time.hours).substr(-2) + ':' +
      ('0' + time.minutes).substr(-2);
    // upcoming occurrence(s)
    const slots = schedule.slots(o);
    const active = alarms.some(a => a.name.startsWith(id + ':'));
    // a once-alarm whose explicit dates are all in the past has no
    // schedulable occurrence left (schedule.slots drops past ones), so the
    // switch can never turn it on; the entry explains itself instead
    const passed = o.repeat === 'once' && slots.length === 0;
    // epochs of this alarm's one-shot slots that actually rang; the browser
    // drops a fired alarm on its own, so this log is the only way to tell a
    // rung date from one that never got scheduled (dropped at toggle time,
    // or missed while the browser was closed)
    const rang = new Set(
      fired.filter(f => f && f.id === id).map(f => Number(f.when))
    );
    // scheduled epochs of this alarm's live slots
    const times = new Set(
      alarms.filter(a => a.name.startsWith(id + ':'))
        .map(a => a.scheduledTime)
    );
    // the definition's zone when the runtime can anchor to it; an
    // imported id it rejects anchors the alarm locally and stays
    // untagged, matching what scheduling does
    const zone = o.zone && schedule.zoneValid(o.zone) ? o.zone : '';
    // the browser-local wall-clock of the next occurrence, shown in ()
    // beside the zone so the list never forces timezone math; zone-less
    // alarms and times that read the same locally show nothing
    const local = zone && slots.length ? alarm.local(slots[0].when, zone) : '';
    // weekday of a scheduled/rung epoch in the alarm's zone: the chips
    // map on the zone's calendar, whose date can differ from the local one
    const pending = new Set(
      [...times].map(t => schedule.wall(t, zone).day)
    );
    const rangDays = new Set(
      [...rang].map(t => schedule.wall(t, zone).day)
    );

    this.#date.textContent = '';
    this.#date.classList.remove('range');

    const span = (text, state = '') => {
      const span = document.createElement('span');
      span.textContent = text;
      if (state) {
        span.classList.add(state);
        span.title = state === 'fired' ? 'Already rang' :
          'Did not ring - time already passed or browser was closed';
      }
      this.#date.appendChild(span);
    };

    // the definition's zone appended to the schedule line, with the
    // local time of its next occurrence beside it (the tooltip carries
    // the full id and the current offset)
    const tagZone = () => {
      if (zone === '') {
        return;
      }
      const tag = document.createElement('span');
      tag.textContent = alarm.zoneLabel(zone) + (local ? ' ' + local : '');
      tag.title = zone + ' (' + alarm.zoneUTC(zone) + ')';
      this.#date.append(tag);
    };

    if (o.repeat === 'weekly') {
      this.#date.classList.add('range');
      for (const d of (o.days || [])) {
        span(PILL[Number(d)]);
      }
      tagZone();
    }
    else if (o.repeat === 'once' && ((o.dates?.length ?? 0) + (o.days?.length ?? 0) > 0)) {
      this.#date.classList.add('range');
      // occurrence state of a chip on an active alarm: plain = scheduled,
      // fired = actually rang, passed = gone without ringing. an OFF alarm
      // has no slots either (cleared, not fired), so it renders plain
      const state = when => active === false ? '' :
        (times.has(when) ? '' : (rang.has(when) ? 'fired' :
          (when <= Date.now() ? 'passed' : '')));
      for (const {y, m, d} of (o.dates || [])) {
        const when = schedule.resolve(Number(y), Number(m), Number(d), time, zone);
        span(d + ' ' + MONTHS[Number(m) - 1], state(when));
      }
      for (const d of (o.days || [])) {
        span(PILL[Number(d)], active === false ? '' :
          (pending.has(Number(d)) ? '' : (rangDays.has(Number(d)) ? 'fired' : 'passed')));
      }
      tagZone();
    }
    else if (o.repeat === 'daily') {
      this.#date.classList.add('range');
      span('Every day');
      tagZone();
    }
    else if (o.repeat === 'monthly') {
      this.#date.classList.add('range');
      span(o.day === 'last' ? 'Last day' : ordinal(Number(o.day)));
      tagZone();
    }
    else if (o.repeat === 'yearly' && o.date) {
      this.#date.classList.add('range');
      span(Number(o.date.d) + ' ' + MONTHS[Number(o.date.m) - 1]);
      tagZone();
    }
    else {
      // no explicit schedule info; show the next computed occurrence,
      // rendered in the alarm's zone with the local time beside it
      if (slots.length === 0) {
        this.#date.textContent = '';
      }
      else if (zone) {
        this.#date.textContent = alarm.format(new Date(slots[0].when), true, zone) +
          ' ' + alarm.zoneLabel(zone) + (local ? ' ' + local : '');
      }
      else {
        this.#date.textContent = alarm.format(new Date(slots[0].when));
      }
    }

    this.dataset.id = id;
    this.setAttribute('disabled', active === false);
    this.#switch.checked = active;
    this.#description.textContent = name || '';
    this.title = passed ? (name ? name + ' - ' : '') + PASSED : (name || '');

    this.#once.textContent = o.repeat === 'once' ? (passed ? 'passed' : 'once') : '';
  }

  // a toggle attempt hit a once-alarm with no schedulable occurrence left
  // (alarm.js refuses to schedule it): snap the switch back off and explain
  // why; the next re-render derives the same state in update()
  passed() {
    this.#switch.checked = false;
    this.#sync();
    this.#once.textContent = 'passed';
    const name = this.#description.textContent || '';
    this.title = (name ? name + ' - ' : '') + PASSED;
  }

  // re-enable a previously active alarm after an edit-and-save
  restart() {
    this.#switch.checked = true;
    this.#sync();
    this.dispatchEvent(new CustomEvent('toggle', {bubbles: true}));
  }
}

customElements.define('alarm-entry', AlarmEntry);
