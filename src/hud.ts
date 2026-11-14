import { NARROW, type App } from './app';
import { esc, fmtMoney, fmtMoneyCompact } from './format';
import { resourceGlyph } from './icons';
import { RESOURCE_LABELS, SOURCES, SOURCE_LABELS, TYPES } from './palette';

const TICKS_PER_DAY = 1440;

export function createHud(app: App) {
  const { view, data } = app;
  const res = document.getElementById('res')!;
  const tick = document.getElementById('tick')!;
  const toggles = document.getElementById('toggles')!;

  const sources = SOURCES.filter((name) => data.sources.includes(name));
  const paints: (() => void)[] = [];
  const all = document.createElement('button');
  all.className = 'chip on';
  all.title = 'Hide or show every resource type and source on the map';
  const trailed = app.traces.length > 0;
  const anyOn = () => TYPES.some((type) => view.show.types[type]) || sources.some((source) => view.show.sources[source]) || (trailed && view.show.trail) || view.show.regions || view.show.entities;
  const paintAll = () => {
    all.textContent = anyOn() ? 'Hide all' : 'Show all';
  };
  all.addEventListener('click', () => {
    const on = !anyOn();
    for (const type of TYPES) view.show.types[type] = on;
    for (const source of sources) view.show.sources[source] = on;
    view.show.trail = on;
    view.show.regions = on;
    view.show.entities = on;
    for (const paint of paints) paint();
    paintAll();
  });
  toggles.append(all);

  const chip = (html: string, title: string, isOn: () => boolean, flip: () => void) => {
    const button = document.createElement('button');
    button.className = 'chip';
    button.innerHTML = html;
    button.title = title;
    const paint = () => button.classList.toggle('on', isOn());
    button.addEventListener('click', () => {
      flip();
      paint();
      paintAll();
    });
    paint();
    paints.push(paint);
    toggles.append(button);
  };
  for (const type of TYPES) {
    chip(
      `${resourceGlyph(type)}${esc(RESOURCE_LABELS[type])}`,
      `Show or hide ${RESOURCE_LABELS[type]}s on the map`,
      () => view.show.types[type],
      () => {
        view.show.types[type] = !view.show.types[type];
      },
    );
  }
  for (const source of sources) {
    chip(
      esc(SOURCE_LABELS[source]),
      `Show or hide what ${SOURCE_LABELS[source]} adds to the map`,
      () => view.show.sources[source],
      () => {
        view.show.sources[source] = !view.show.sources[source];
      },
    );
  }
  if (trailed)
    chip(
      'Snail trail',
      'Show or hide the trail left where concepts and creatives have been carried',
      () => view.show.trail,
      () => {
        view.show.trail = !view.show.trail;
      },
    );
  chip(
    'Region labels',
    'Show or hide the region names on the map',
    () => view.show.regions,
    () => {
      view.show.regions = !view.show.regions;
    },
  );
  chip(
    'Entity labels',
    'Show or hide the emails under the people and animals on the map',
    () => view.show.entities,
    () => {
      view.show.entities = !view.show.entities;
    },
  );
  paintAll();

  const figures = (totals: Record<string, number>, short: boolean, tone = '') => {
    const keys = Object.keys(totals).sort();
    const fmt = short ? fmtMoneyCompact : fmtMoney;
    const b = tone ? `<b class="${tone}">` : '<b>';
    return keys.length ? keys.map((currency) => `${b}${esc(fmt(totals[currency], currency))}</b>`).join(short ? ' ' : '') : '<b>–</b>';
  };
  const item = (label: string, value: string, title = '') => `<span class="res"${title ? ` title="${esc(title)}"` : ''}><em>${label}</em>${value}</span>`;
  const COSTS =
    'Every card charge and payout, added the moment it lands, plus metered usage paid outside the card. Usage prepaid through the card is listed in the card building and not added again.';

  let tight = false;
  window.addEventListener('resize', () => {
    tight = false;
  });
  let shownRes = '';
  let shownTick = '';
  app.onFrame(() => {
    const state = app.state;
    if (!state) return;
    const spend: Record<string, number> = {};
    const fees: Record<string, number> = {};
    const ours: Record<string, number> = {};
    const spent: Record<string, number> = {};
    for (const counter of state.counters) {
      for (const currency in counter.adSpend) spend[currency] = (spend[currency] ?? 0) + counter.adSpend[currency];
      for (const currency in counter.ownSpend) ours[currency] = (ours[currency] ?? 0) + counter.ownSpend[currency];
      for (const currency in counter.feeRevenue) fees[currency] = (fees[currency] ?? 0) + counter.feeRevenue[currency];
      for (const totals of Object.values(counter.expenses)) for (const currency in totals) spent[currency] = (spent[currency] ?? 0) + totals[currency];
    }
    const short = NARROW.matches || tight;
    const html = !view.show.sources.money
      ? ''
      : item(short ? 'Spend' : 'Ad spend', figures(spend, short)) +
      item(short ? 'Ours' : 'Our spend', figures(ours, short)) +
      item('Fees', figures(fees, short, 'in')) +
      (data.sources.includes('spend') ? item('Costs', figures(spent, short, 'out'), COSTS) : '') +
      item('Agents', `<b>${state.agents.length}</b>`);
    if (html !== shownRes) {
      shownRes = html;
      res.innerHTML = html;
      if (!short && res.scrollWidth > res.clientWidth + 1) tight = true;
    }
    const text = short
      ? `Day ${app.dayOffset + state.tick.day + 1} · ${state.tick.minute}`
      : `Day ${app.dayOffset + state.tick.day + 1} · tick ${state.tick.minute} / ${TICKS_PER_DAY}`;
    if (text !== shownTick) {
      shownTick = text;
      tick.textContent = text;
    }
  });
}
