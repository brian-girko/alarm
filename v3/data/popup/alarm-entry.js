/* globals schedule, alarm, MONTHS, PILL, ordinal */
'use strict';

// <alarm-entry>: one alarm in the list view. The markup, styles, and
// interactions live in an open shadow root; the page drives the view through
// update(raw, alarms) / restart() and listens to the bubbling custom events:
//   toggle - the enable/disable switch changed (scheduling lives in alarm.js)
//   edit   - the edit button was clicked
//   remove - the remove button was clicked

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
  input[type="checkbox"] {
    visibility: hidden;
    width: 28px;
    height: 28px;
  }
  input[type="checkbox"].switch {
    grid-area: switch;
    justify-self: end;
  }
  input[type="checkbox"].switch::after {
    content: '';
    width: 32px;
    height: 100%;
    line-height: 28px;
    display: inline-block;
    background: url('icons/switch-off.svg') center center no-repeat;
    background-size: 32px;
    visibility: visible;
    cursor: pointer;
  }
  input[type="checkbox"].switch:checked::after {
    background-image: url('icons/switch-on.svg');
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

  update(raw, alarms) {
    const o = this.#o = schedule.normalize(raw);
    const {id, time, name} = o;
    // time
    this.#time.textContent =
      ('0' + time.hours).substr(-2) + ':' +
      ('0' + time.minutes).substr(-2);
    // upcoming occurrence(s)
    const slots = schedule.slots(o);
    const active = alarms.some(a => a.name.startsWith(id + ':'));
    // scheduled epochs of this alarm's live slots; a fired one-shot ("once")
    // slot vanishes from chrome.alarms - render that weekday/date struck
    // through. an OFF alarm has no slots either (cleared, not fired), so it
    // renders without strikes
    const times = new Set(
      alarms.filter(a => a.name.startsWith(id + ':'))
        .map(a => a.scheduledTime)
    );
    const pending = new Set(
      [...times].map(t => new Date(t).getDay())
    );

    this.#date.textContent = '';
    this.#date.classList.remove('range');

    const span = (text, fired = false) => {
      const span = document.createElement('span');
      span.textContent = text;
      if (fired) {
        span.classList.add('fired');
      }
      this.#date.appendChild(span);
    };

    if (o.repeat === 'weekly') {
      this.#date.classList.add('range');
      for (const d of (o.days || [])) {
        span(PILL[Number(d)]);
      }
    }
    else if (o.repeat === 'once' && ((o.dates?.length ?? 0) + (o.days?.length ?? 0) > 0)) {
      this.#date.classList.add('range');
      for (const {y, m, d} of (o.dates || [])) {
        const when = schedule.resolve(Number(y), Number(m), Number(d), time);
        span(d + ' ' + MONTHS[Number(m) - 1], active && times.has(when) === false);
      }
      for (const d of (o.days || [])) {
        span(PILL[Number(d)], active && pending.has(Number(d)) === false);
      }
    }
    else if (o.repeat === 'daily') {
      this.#date.classList.add('range');
      span('Every day');
    }
    else if (o.repeat === 'monthly') {
      this.#date.classList.add('range');
      span(o.day === 'last' ? 'Last day' : ordinal(Number(o.day)));
    }
    else if (o.repeat === 'yearly' && o.date) {
      this.#date.classList.add('range');
      span(Number(o.date.d) + ' ' + MONTHS[Number(o.date.m) - 1]);
    }
    else {
      // no explicit schedule info; show the next computed occurrence
      this.#date.textContent = slots.length ? alarm.format(new Date(slots[0].when)) : '';
    }

    this.dataset.id = id;
    this.setAttribute('disabled', active === false);
    this.#switch.checked = active;
    this.title = this.#description.textContent = name || '';

    this.#once.textContent = o.repeat === 'once' ? 'once' : '';
  }

  // re-enable a previously active alarm after an edit-and-save
  restart() {
    this.#switch.checked = true;
    this.#sync();
    this.dispatchEvent(new CustomEvent('toggle', {bubbles: true}));
  }
}

customElements.define('alarm-entry', AlarmEntry);
