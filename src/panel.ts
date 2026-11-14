import { NARROW, type App, type Pick } from './app';
import { costLabel, esc, fmtClock, fmtCompact, fmtCostPer, fmtDate, fmtDuration, fmtExact, fmtMoney, fmtPct, fmtWhen } from './format';
import { glyph, resourceGlyph, spriteGlyph } from './icons';
import { COLORS, RESOURCE_COLORS, RESOURCE_LABELS, SOURCE_LABELS, STAGE_COLORS, TOOLS, TOOL_LABELS, TYPES, UNIT_COLORS, byOrigin, originColor, originName } from './palette';
import { CARRIED_STATS, LEAD_STAGES, RECRUIT_REGION, RECRUIT_STAGES, type Metric, type MetricRow, type PersonStats, type UnitKind } from './schema';
import type { LayoutBuilding, PerResource, SimState } from './seam';
import { addMoney, billsOf, type Money } from './sim/bills';
import { ANIMAL_OF, ROLES, ROLE_LABELS } from './sprites';
import { createTraces } from './traces';

const UNIT_KINDS: [UnitKind, string][] = [
  ['person', 'person'],
  ['client', 'client person'],
  ['automation', 'automation'],
  ['system', 'system'],
  ['prospect', 'prospect or lead: a traveller. Leads stand in the columns left of the map and step right from form submitted to qualified, call booked, met and proposal; no-shows are held in the prison below the columns; the ones we only dream about (CRM prospecting targets and prospect records someone looked up) float in the Dream section above them. Each is outlined in the colour of where they came from'],
  ['ambassador', 'ambassador: someone outside the company who refers new clients. Each has a market stall in the Ambassadors region and walks over to a client they brought'],
  ['recruit', 'recruit: a job candidate who has reached the take-home. A wizard is applying for creative, a ranger for engineering and a knight for media buying. Recruits stand in the recruiting yards above the map and step right from take-home to screen, tech screen, onsite and offer; one we hire walks down into the home region, one we pass on leaves'],
];
const LEGEND_KEY = 'rts.legend';
const SIDE_KEY = 'rts.side';
const MONEY_NOTES: Record<string, string> = {
  ramp: 'Each card charge adds its amount to Costs in the top bar the moment it lands. A usage line is what we used of the credits these charges buy; it is shown for comparison and not added to Costs again.',
  ambassadors: 'Each payout adds its amount to Costs in the top bar the moment it is sent.',
  'client-billing': 'Invoices finalized and sent to clients, less any voided.',
};
const FUNCTION_LABELS: Record<string, string> = {
  sales_bd: 'Sales and BD',
  creative_strategy: 'Creative strategy',
  client_onboarding: 'Client onboarding',
  organic_content: 'Organic content',
  creative_production: 'Creative production',
  internal_ops: 'Internal ops',
  finance_billing: 'Finance and billing',
  hiring: 'Hiring',
  client_retention: 'Client retention',
  client_results: 'Client results',
};

const clampTo = (value: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, value));

export function createPanel(app: App) {
  const { layout, sim } = app;
  let data = app.data;
  const root = document.getElementById('panel')!;
  const body = document.getElementById('panel-body')!;
  const shell = document.getElementById('app')!;
  const acts = document.getElementById('acts')!;
  const openButton = document.getElementById('panel-open')!;
  const closeButton = document.getElementById('panel-close')!;
  const sideButton = document.getElementById('side-toggle')!;
  const traces = createTraces(app, root);
  const people = new Map([...app.world.units, ...data.units].map((p) => [p.id, p]));
  const regionNames = new Map(app.world.regions.map((r) => [r.id, r.name]));
  const regionName = (id: string) => app.regionName(id, regionNames.get(id) ?? id);
  const cash = () => app.view.show.sources.money;
  const groupNames = new Map(app.world.groups.map((g) => [g.id, g.name]));
  const regions = new Map(layout.regions.map((r) => [r.id, r]));
  const buildings = new Map(layout.buildings.map((b) => [b.id, b]));
  const zero = () => Object.fromEntries(TYPES.map((type) => [type, 0])) as PerResource;
  let stats = new Map<string, PersonStats>();
  let created = new Map<string, PerResource & { other: number }>();
  let featureTotals = new Map<string, { activity: number; errors: number }>();
  let bills = billsOf(data, app.carried.bills);
  let paidBy = new Map<string, string>();
  const derive = () => {
    data = app.data;
    const carried = app.carried;
    bills = billsOf(data, carried.bills);
    paidBy = new Map(data.measures.flatMap((m) => (m.paidBy ? [[m.label ?? m.paidBy, m.paidBy] as const] : [])));
    for (const p of data.units) people.set(p.id, p);
    stats = new Map((data.weekly?.people ?? []).map((s) => [s.id, { ...s }]));
    for (const [id, row] of Object.entries(carried.people)) {
      let s = stats.get(id);
      if (!s) stats.set(id, (s = { id, in: 0, out: 0, returnsIn: 0, returnsOut: 0, holdMedianMs: null, holdP75Ms: null, holdSamples: 0, assignsGiven: 0, assignsReceived: 0, creates: 0, comments: 0, done: 0, edits: 0, bulkEvents: 0, bulkCovered: 0 }));
      CARRIED_STATS.forEach((key, i) => (s![key] += row[i] ?? 0));
    }
    created = new Map();
    for (const [id, made] of Object.entries(carried.created)) {
      const entry = { ...zero(), other: 0 } as PerResource & { other: number };
      for (const type in made) (entry as Record<string, number>)[type] = made[type];
      created.set(id, entry);
    }
    for (const e of data.events) {
      if (e.kind !== 'create' || !e.building) continue;
      if (!created.has(e.building)) created.set(e.building, { ...zero(), other: 0 });
      created.get(e.building)![e.resource ?? 'other'] += e.count;
    }

    featureTotals = new Map(Object.entries(carried.features).map(([id, [activity, errors]]) => [id, { activity, errors }]));
    for (const e of data.events) {
      if (!e.feature) continue;
      if (!featureTotals.has(e.feature)) featureTotals.set(e.feature, { activity: 0, errors: 0 });
      const entry = featureTotals.get(e.feature)!;
      if (e.kind === 'error') entry.errors += e.count;
      else entry.activity += e.count;
    }
    for (const s of data.sessions) {
      const id = `claude/${s.tool}`;
      if (!featureTotals.has(id)) featureTotals.set(id, { activity: 0, errors: 0 });
      featureTotals.get(id)!.activity++;
    }
  };
  derive();

  const label = (id: string) => layout.units[layout.index.get(id)!]?.label ?? id;
  const who = (id: string) =>
    `<a class="who" data-id="${esc(id)}" title="${esc(people.get(id)?.name ?? id)}">${esc(label(id))}</a>`;
  const num = (n: number) => `<td class="n">${n}</td>`;
  const table = (head: string[], rows: string[]) =>
    `<table><thead><tr>${head
      .map((h, i) => `<th${i ? ' class="n"' : ''}>${h}</th>`)
      .join('')}</tr></thead><tbody>${rows.join('')}</tbody></table>`;
  const byType = (counts: PerResource) =>
    TYPES.filter((type) => counts[type] > 0)
      .map((type) => `<span class="tc" data-tip="${counts[type]} ${RESOURCE_LABELS[type]}${counts[type] === 1 ? '' : 's'}">${resourceGlyph(type)}${counts[type]}</span>`)
      .join('') || '–';
  const sum = (lanes: { count: PerResource }[]) => {
    const out: PerResource = zero();
    for (const lane of lanes) for (const type of TYPES) out[type] += lane.count[type];
    return out;
  };
  const figures = (totals: Record<string, number>) =>
    Object.keys(totals)
      .sort()
      .map((currency) => fmtMoney(totals[currency], currency))
      .join(' + ') || '–';

  const dayLabel = new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', month: 'short', day: 'numeric' });
  const isoDate = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit' });
  const weekOf = (w: { start: number; end: number }) => `Week of ${fmtDate(w.start)} to ${fmtDate(w.end)}`;
  const weekStart = () => isoDate.format(data.window.start);
  const weekEnd = () => isoDate.format(data.window.end - 1);
  const words = (text: string) => {
    const spaced = text.replace(/_/g, ' ');
    return spaced.charAt(0).toUpperCase() + spaced.slice(1);
  };
  const dated = (date: string) => `${dayLabel.format(Date.parse(`${date}T00:00:00Z`))}${date.slice(0, 4) === weekEnd().slice(0, 4) ? '' : ` ${date.slice(0, 4)}`}`;
  const period = (r: MetricRow) =>
    !r.start || !r.end || (r.start === weekStart() && r.end === weekEnd()) ? '' : r.start === r.end ? dated(r.start) : `${dated(r.start)} to ${dated(r.end)}`;
  const plain = (n: number) => n.toLocaleString('en-US', { maximumFractionDigits: Math.abs(n) < 100 ? 1 : 0 });
  const amount = (value: string, unit: string) => {
    if (value === '') return '–';
    const n = Number(value);
    if (!Number.isFinite(n)) return esc(words(value));
    if (unit === 'ratio') return `${(n * 100).toLocaleString('en-US', { maximumFractionDigits: Math.abs(n) < 0.1 ? 1 : 0 })}%`;
    if (unit === 'usd') return fmtMoney(n, 'USD');
    if (unit === 'days') return `${plain(n)}d`;
    if (unit === 'minutes') return `${plain(n)}m`;
    return plain(n);
  };
  const basis = (r: MetricRow, unit: string) =>
    unit === 'ratio' && r.num !== '' && r.den !== '' && Number.isFinite(Number(r.num)) && Number.isFinite(Number(r.den)) ? `${plain(Number(r.num))} of ${plain(Number(r.den))}` : '';

  function metricHtml(m: Metric) {
    const sub = m.head ? [basis(m.head, m.unit), period(m.head)].filter(Boolean).join(' · ') : '';
    return `
      <div class="metric" title="${esc(m.head?.note ?? m.parts[0]?.rows[0]?.note ?? '')}">
        <span>${esc(words(m.name))}</span><b>${m.head ? amount(m.head.value, m.unit) : ''}</b>
        ${sub ? `<small>${esc(sub)}</small>` : ''}
      </div>
      ${m.parts
        .filter((part) => app.view.show.regions || part.by !== 'company')
        .map((part) => {
          const periods = new Set(part.rows.map(period));
          const shared = periods.size === 1 ? [...periods][0] : null;
          return `<details><summary>By ${esc(words(part.by).toLowerCase())} · ${part.rows.length}${shared ? ` · ${esc(shared)}` : ''}</summary>${table(
            [words(part.by), 'Value', 'Of', ...(shared === null ? ['Period'] : [])],
            part.rows.map(
              (r) =>
                `<tr title="${esc(r.note)}"><td class="clip">${esc(r.label)}</td><td class="n">${amount(r.value, m.unit)}</td><td class="n">${esc(basis(r, m.unit)) || '–'}</td>${
                  shared === null ? `<td class="n">${esc(period(r)) || 'this week'}</td>` : ''
                }</tr>`,
            ),
          )}</details>`;
        })
        .join('')}`;
  }

  function metricsHtml() {
    const metrics = (data.metrics ?? []).filter((m) => cash() || m.unit !== 'usd');
    if (!metrics.length) return '<section><h2>Business metrics</h2><p class="note">No business metrics in this replay. </p></section>';
    const byFunction = new Map<string, Metric[]>();
    for (const m of metrics) {
      if (!byFunction.has(m.fn)) byFunction.set(m.fn, []);
      byFunction.get(m.fn)!.push(m);
    }
    return `${[...byFunction]
      .map(([fn, list]) => `<section><h2>${esc(FUNCTION_LABELS[fn] ?? words(fn))}</h2>${list.map(metricHtml).join('')}</section>`)
      .join('')}
      <p class="note">Computed from the pulled data of the ${esc(weekOf(data.window).toLowerCase())}. Hover a metric for its definition.</p>`;
  }

  const row = (icons: string, text: string) => `<div>${icons}<span>${text}</span></div>`;
  const legend = document.createElement('section');
  legend.id = 'legend';
  legend.className = 'legend';
  legend.innerHTML = `
    <button id="legend-toggle" aria-controls="legend-body">Legend</button>
    <div id="legend-body">
      <h3>Units</h3>
      ${ROLES.map((role) =>
        row(
          spriteGlyph(role, UNIT_COLORS.person.fill, UNIT_COLORS.person.edge) + spriteGlyph(ANIMAL_OF[role], UNIT_COLORS.automation.fill, UNIT_COLORS.automation.edge),
          `${ROLE_LABELS[role]}; a ${ANIMAL_OF[role]} when it is an automation`,
        ),
      ).join('')}
      ${UNIT_KINDS.map(([kind, name]) =>
        row(kind === 'prospect' || kind === 'recruit' ? spriteGlyph(kind === 'recruit' ? 'recruit' : 'traveller', UNIT_COLORS[kind].fill, UNIT_COLORS[kind].edge) : glyph('circle', UNIT_COLORS[kind].fill, UNIT_COLORS[kind].edge), name),
      ).join('')}
      ${[...new Set(data.units.filter((u) => u.kind === 'prospect' && u.stages?.length).map((u) => u.origin ?? ''))]
        .sort(byOrigin)
        .map((origin) => row(spriteGlyph('traveller', UNIT_COLORS.prospect.fill, originColor(origin)), `lead source: ${esc(originName(origin))}`))
        .join('')}
      ${row('', 'initials on the chest, name below when zoomed in; brighter means recently active')}
      ${
        data.busy?.length
          ? `${row(glyph('ring', COLORS.meeting, null, 2.4), 'purple ring: in a meeting, seated at a round table sized small, medium or large by headcount')}
      ${row(glyph('tick', COLORS.away, null, 2), 'faded with a slash: out of office')}`
          : ''
      }
      <h3>Resources</h3>
      ${TYPES.map((type) => row(resourceGlyph(type), RESOURCE_LABELS[type])).join('')}
      ${row('', 'each resource in its own shade of its type colour')}
      ${row(TYPES.map((type) => resourceGlyph(type, COLORS.return)).join(''), 'orange outline: a return to an earlier holder')}
      ${row('', 'large: sent on · small: assigned · white dot: sent by an agent · a new resource is collected at its tool by whoever made it and carried back')}
      ${row('', 'the stack to the right of a unit is what it holds now')}
      ${
        app.traces.length
          ? `<h3>Concepts</h3>
      ${row(resourceGlyph('ticket') + resourceGlyph('board'), 'a concept: its ticket, joined by its board once that exists. It appears beside the tool that made it and waits in the pile under that tool, shown as a count you can click to list what is in it, until someone walks over and carries it away; while they have it, it waits in a pile beside their house, also a count you can click, until nothing has happened to it for five days. Hover for the ticket, click to open its trace')}
      ${row(resourceGlyph('page'), 'a brief written for a concept. It appears beside Notion and waits in the pile under it, shown as a count you can click to list the briefs with their links, until someone who works on it carries it away. Hover for the brief, click to open its concept')}
      ${row(resourceGlyph('video') + resourceGlyph('taxonomy') + resourceGlyph('row') + resourceGlyph('ad'), 'a creative made from a concept: its video or image, then its taxonomy name, its sheet row and its ads as each is made. Every new part appears at its tool and is carried over to join it')}
      ${row(glyph('square', STAGE_COLORS.edit), 'the field at the bottom of a client region is its ad account: when a creative launches, someone collects it at the ad platforms and plants it there. It grows with each ad, turns gold with a star when it wins, turns grey again when its win streak ends, and greys when its ads are turned off. Five days after that it is put away in the silo on the field\'s top edge, which shows a count you can click to list what is in it')}
      ${row(glyph('square', COLORS.away), 'greyer the longer nothing has happened to it; after five days it moves to the idle store at the bottom of the home region and is counted there until someone fetches it')}
      ${row(glyph('circle', STAGE_COLORS.asset), 'snail trail: the ground lightens wherever a concept that went on to produce a winner, or one of its creatives, has been carried (click a trail to pick that concept), brighter where more have gone and where one passed in the last few hours, a shade dimmer every four hours until it is gone after a day')}`
          : ''
      }
      <h3>Events</h3>
      ${row(glyph('ring', COLORS.neutral, null, 1.4), 'created')}
      ${row(glyph('dashed', COLORS.neutral, null, 1.6), 'comment')}
      ${row(glyph('ring', COLORS.neutral, null, 3), 'done')}
      ${row(glyph('tick', COLORS.neutral, null, 1.8), 'edit')}
      ${row(glyph('ring', COLORS.bulk, null, 3.4), 'bulk ×N: a script or agent under this key')}
      ${row(resourceGlyph('ad') + glyph('chevron', COLORS.bg, RESOURCE_COLORS.ad, 1.5), 'filled: a campaign, ad set or ad switched on · hollow: switched off')}
      ${row(resourceGlyph('resume') + glyph('sheet', COLORS.bg, RESOURCE_COLORS.resume, 1.5), 'filled: a resume arrives · hollow: we passed on it')}
      ${row('', 'rings take the colour of their resource type')}
      ${
        data.sessions.length
          ? `<h3>Agents (AI sessions)</h3>
      ${row(spriteGlyph('cat', COLORS.agent, COLORS.bg), `a cat for each session: ${TOOLS.map((tool) => TOOL_LABELS[tool]).join(', ')}`)}
      ${row('', 'pulsing: working · dim: idle · kitten on a tether: subagent · +N: more than 8')}`
          : ''
      }
      <h3>Map</h3>
      ${row(glyph('house', COLORS.neutral), 'structure: a tool or service; pulses when a resource is created there')}
      ${row(glyph('square', COLORS.neutral), 'each cell is one of its features: brighter with more activity, red when it has errors, with a running count')}
      ${row(glyph('circle', COLORS.use), 'teal dot: someone using a feature')}
      ${row(glyph('star', COLORS.trophy), 'winning ad: a creative we made that started a win streak under that client\'s winner rule; its plot is gold while the streak lasts and grey once it ends')}
      ${row(glyph('star', COLORS.bg, COLORS.trophy, 1.5), 'creative launched: an ad we made that started spending this week')}
      ${row(resourceGlyph('client_winner'), 'client winner: an ad the client made, not us, that started a win streak under the same rule; it takes a plot in their field with a red star while the streak lasts. Click it to inspect it. A concept that grew out of one keeps it as its first stage')}
      ${row('', 'under a region name: ad spend · cost per conversion / goal · fees, so far, and ads live now; under the home region, what we spent so far')}
      ${row(resourceGlyph('bill'), 'beside a building name: what its bills add up to so far, rising the moment each bill lands')}
      ${row(resourceGlyph('resume'), 'at recruiting: the numbers in the applied yard are how many resumes wait there now, split by craft; from the take-home on, each applicant stands in their yard')}
      ${row('', 'bottom right of a region: how many of each resource type were made there so far, with ★ winning ads and ☆ creatives launched')}
      ${row(glyph('house', COLORS.neutral), 'automations: the ones with nothing to do wait inside and step out when they run; the number is how many are in')}
      ${row('', 'a dimmed client region had nothing happen in the last replay day')}
      ${app.traces.length ? row(glyph('ring', COLORS.trace, null, 2.4), 'magenta: a picked concept trace. Its path is laid out in crumbs, its concept and creatives are circled wherever they lie, the ad field, pile or store holding one is outlined in magenta, its resources in flight and its events glow, everyone who touched it is ringed, the buildings it passed through are outlined, the rest fades') : ''}
    </div>`;
  const legendToggle = legend.querySelector<HTMLElement>('#legend-toggle')!;
  const legendBody = legend.querySelector<HTMLElement>('#legend-body')!;

  let staticHtml = metricsHtml();

  const legendChoice = () => {
    try {
      const saved = sessionStorage.getItem(LEGEND_KEY);
      return saved === null ? null : saved === 'open';
    } catch {
      return null;
    }
  };
  const params = new URLSearchParams(location.search);
  let legendForced = params.get('legend') === 'open' ? true : params.get('legend') === 'closed' ? false : null;
  const legendStart = () => legendForced ?? legendChoice() ?? !NARROW.matches;
  let legendOpen = legendStart();
  let panelOpen = false;
  let sideOpen = true;
  try {
    sideOpen = sessionStorage.getItem(SIDE_KEY) !== 'closed';
  } catch {}

  function setSide(open: boolean) {
    sideOpen = open;
    try {
      sessionStorage.setItem(SIDE_KEY, open ? 'open' : 'closed');
    } catch {}
    paintChrome();
  }

  function paintChrome() {
    shell.classList.toggle('side-closed', !sideOpen && !NARROW.matches);
    sideButton.setAttribute('aria-expanded', String(sideOpen));
    sideButton.title = sideOpen ? 'Hide the sidebar' : 'Show the sidebar';
    legendBody.hidden = !legendOpen;
    legendToggle.setAttribute('aria-expanded', String(legendOpen));
    legendToggle.title = legendOpen ? 'Hide the legend' : 'Show the legend';
    shell.classList.toggle('panel-open', panelOpen);
    openButton.classList.toggle('on', panelOpen);
    openButton.setAttribute('aria-expanded', String(panelOpen));
  }

  function setLegend(open: boolean, keep: boolean) {
    legendOpen = open;
    if (keep) {
      legendForced = null;
      try {
        sessionStorage.setItem(LEGEND_KEY, open ? 'open' : 'closed');
      } catch {}
    }
    if (open && NARROW.matches) panelOpen = false;
    paintChrome();
  }

  function setPanel(open: boolean) {
    panelOpen = open;
    if (open) sideOpen = true;
    if (open && NARROW.matches) legendOpen = false;
    paintChrome();
  }

  function place() {
    if (NARROW.matches) acts.prepend(legend);
    else root.append(legend);
    legendOpen = legendStart();
    if (legendOpen && NARROW.matches) panelOpen = false;
    paintChrome();
  }

  legendToggle.addEventListener('click', () => setLegend(!legendOpen, true));
  openButton.addEventListener('click', () => setPanel(!panelOpen));
  closeButton.addEventListener('click', () => setPanel(false));
  sideButton.addEventListener('click', () => setSide(!sideOpen));
  NARROW.addEventListener('change', place);

  function unitCard(id: string) {
    const person = people.get(id);
    if (!person) return '';
    const s: PersonStats | undefined = stats.get(id);
    const kind =
      person.kind === 'automation'
        ? 'automation (20+ comments, never a creator or assignee)'
        : person.kind === 'system'
          ? 'system actor'
          : person.kind === 'client'
            ? 'client person'
            : person.kind === 'recruit'
              ? 'recruit (job candidate)'
              : person.kind === 'ambassador'
                ? 'ambassador (refers new clients)'
              : person.kind;
    const place = (person.group && groupNames.get(person.group)) ?? regionName(person.region);
    return `
      <section class="card">
        <button id="clear" title="Clear selection">×</button>
        <h1>${esc(person.name)}</h1>
        <p class="sub">${esc(place)} · ${kind} · ${layout.units[layout.index.get(id)!]?.role ?? 'townsfolk'}${person.kind === 'prospect' && person.stages?.length ? ` · source: ${esc(originName(person.origin))}` : ''}</p>
        <div id="live"></div>
        <dl>
          ${
            s
              ? `<dt>Assigns given / received</dt><dd>${s.assignsGiven} / ${s.assignsReceived}</dd>
          <dt>Created</dt><dd>${s.creates}</dd>
          <dt>Comments</dt><dd>${s.comments}</dd>
          <dt>Done</dt><dd>${s.done}</dd>
          <dt>Edits</dt><dd>${s.edits}</dd>
          <dt>Bulk events</dt><dd>${s.bulkEvents} · ${s.bulkCovered} actions</dd>`
              : ''
          }
        </dl>
        ${traces.unit(id)}
      </section>`;
  }

  function regionCard(id: string) {
    const region = regions.get(id);
    if (!region) return '';
    const members = layout.units.filter((u) => u.region === id);
    const housed = layout.buildings.filter((b) => b.region === id);
    return `
      <section class="card">
        <button id="clear" title="Clear selection">×</button>
        <h1>${esc(app.regionName(id, region.name))}</h1>
        <p class="sub">${region.kind === 'client' ? 'client region' : region.kind === 'internal' ? 'internal region' : region.kind === 'recruiting' ? 'recruiting' : region.kind === 'bazaar' ? 'ambassador program' : 'not matched to a region'} · ${members.length} ${members.length === 1 ? 'unit' : 'units'}${traces.jump(id)}</p>
        <div id="live"></div>
        <h2>People</h2>
        <p class="list">${members.map((u) => who(u.id)).join(' · ') || '–'}</p>
        ${housed.length ? `<h2>Buildings</h2><p class="list">${housed.map((b) => `<a class="who" data-id="${esc(b.id)}">${esc(b.name)}</a>`).join(' · ')}</p>` : ''}
        ${traces.region(id)}
      </section>`;
  }

  function barnCard() {
    return `
      <section class="card">
        <button id="clear" title="Clear selection">×</button>
        <h1>Automations</h1>
        <p class="sub">automations with nothing to do right now</p>
        <div id="live"></div>
      </section>`;
  }

  function storeCard(id: string) {
    const many = id === 'store:creative' ? 'creatives' : id === 'store:brief' ? 'briefs' : 'concepts';
    return `
      <section class="card">
        <button id="clear" title="Clear selection">×</button>
        <h1>Idle ${many}</h1>
        <p class="sub">${many} nothing has happened to for five days, waiting here until someone picks them up again</p>
        <div id="live"></div>
      </section>`;
  }

  const STORE_ROWS = 150;

  function crowdCard(id: string) {
    const applied = id.startsWith('applied/');
    const [place = '', kind = '', packed = '', origin = ''] = id.split('|');
    const role = applied ? id.slice(8) : packed;
    const level = Number(place.slice(place.lastIndexOf('/') + 1));
    const stage = applied ? RECRUIT_STAGES[0] : kind === 'recruit' ? RECRUIT_STAGES[level] : kind === 'prospect' ? LEAD_STAGES[level] : regionNames.has(place) ? regionName(place) : null;
    const craft = role === 'ranger' ? 'engineering' : role === 'wizard' ? 'creative' : role === 'knight' ? 'media buying' : null;
    const what = applied || kind === 'recruit' ? (craft ? `${craft} candidates` : 'candidates for other roles') : kind === 'prospect' ? `${originName(origin)} ${role}s` : `${role}s`;
    return `
      <section class="card">
        <button id="clear" title="Clear selection">×</button>
        <h1>${esc(stage ?? 'Group')} · ${esc(what)}</h1>
        <p class="sub">${applied || place.startsWith(RECRUIT_REGION) ? 'everyone counted in this group on the training grounds right now' : 'everyone counted in this group right now'}</p>
        <div id="live"></div>
      </section>`;
  }

  const featureIndex = new Map(layout.features.map((f, i) => [f.id, i]));
  const featureNames = new Map((app.world.features ?? []).map((f) => [f.id, f.name]));
  const weight = (money: Money) => Object.values(money).reduce((n, value) => n + Math.abs(value), 0);
  const tally = (map: Map<string, Money>, key: string, currency: string, value: number) => {
    if (!map.has(key)) map.set(key, {});
    addMoney(map.get(key)!, currency, value);
  };

  function billsHtml(b: LayoutBuilding, state: SimState) {
    const landed = bills.landed(b.id, state.t);
    const byFeature = new Map<string, Money>();
    const byClient = new Map<string, Money>();
    const counted = new Map<string, number>();
    for (const e of landed) {
      const currency = e.currency ?? '';
      if (e.feature) tally(byFeature, e.feature, currency, e.amount!);
      if (e.region && e.region !== b.region) {
        tally(byClient, e.region, currency, e.amount!);
        if (e.kind === 'create') counted.set(e.region, (counted.get(e.region) ?? 0) + 1);
      }
    }
    const used = new Map<string, Money>();
    for (const counter of state.counters) {
      for (const [label, totals] of Object.entries(counter.usage ?? {})) {
        if (paidBy.get(label) === b.id) for (const currency in totals) tally(used, label, currency, totals[currency]);
      }
    }
    const rows = b.features
      .map((f) => {
        const live = state.features[featureIndex.get(f.id) ?? -1];
        return { f, activity: live?.total ?? 0, errors: live?.errors ?? 0, money: byFeature.get(f.id) ?? {} };
      })
      .sort((x, y) => weight(y.money) - weight(x.money) || y.activity + y.errors - (x.activity + x.errors));
    const clients = [...byClient].sort((x, y) => weight(y[1]) - weight(x[1]) || x[0].localeCompare(y[0]));
    const what = (e: (typeof landed)[number]) => (e.region && e.region !== b.region && regionNames.has(e.region) && regionName(e.region)) || featureNames.get(e.feature ?? '') || 'Bill';
    const note = MONEY_NOTES[b.id];
    return `<dl>
        <dt>Bills so far</dt><dd>${landed.filter((e) => e.kind === 'create').length}</dd>
        <dt>Amount so far</dt><dd>${figures(bills.total(b.id, state.t))}</dd>
        ${[...used].map(([label, totals]) => `<dt>${esc(label)} usage so far</dt><dd>${figures(totals)}</dd>`).join('')}
      </dl>
      ${note ? `<p class="note">${esc(note)}</p>` : ''}
      ${
        landed.length
          ? `<h2>Latest bills</h2>${table(
              ['Bill', 'Who', 'When', 'Amount'],
              landed
                .slice(-8)
                .reverse()
                .map((e) => `<tr><td class="clip">${esc(what(e))}</td><td class="n">${who(e.actor)}</td><td class="n">${esc(fmtWhen(e.t))}</td><td class="n">${esc(fmtExact(e.amount!, e.currency ?? ''))}</td></tr>`),
            )}`
          : ''
      }
      ${
        rows.length
          ? `<h2>Features</h2>${table(
              ['Feature', 'Activity', 'Errors', 'Amount'],
              rows.map(
                ({ f, activity, errors, money }) =>
                  `<tr><td class="clip">${esc(f.name)}</td><td class="n">${fmtCompact(activity)}</td><td class="n">${errors ? fmtCompact(errors) : '–'}</td><td class="n">${figures(money)}</td></tr>`,
              ),
            )}`
          : ''
      }
      ${
        clients.length
          ? `<h2>By client</h2>${table(
              ['Client', 'Bills', 'Amount'],
              clients.map(([region, money]) => `<tr><td class="clip"><a class="who" data-id="${esc(region)}">${esc(regionName(region))}</a></td>${num(counted.get(region) ?? 0)}<td class="n">${figures(money)}</td></tr>`),
            )}`
          : ''
      }`;
  }

  function buildingCard(id: string) {
    const b = buildings.get(id);
    if (!b) return '';
    const made = created.get(id) ?? { ...zero(), other: 0 };
    const total = TYPES.reduce((n, type) => n + made[type], made.other);
    return `
      <section class="card">
        <button id="clear" title="Clear selection">×</button>
        <h1>${esc(b.name)}</h1>
        <p class="sub">building in <a class="who" data-id="${esc(b.region)}">${esc(regionName(b.region))}</a>${
          b.resource ? ` · makes ${RESOURCE_LABELS[b.resource]}s` : ''
        }</p>
        <dl>
          <dt>Resources created in the window</dt><dd>${total}</dd>
          <dt>By type</dt><dd>${byType(made)}</dd>
        </dl>
        ${
          bills.has(id)
            ? '<div id="live"></div>'
            : b.features.length
            ? `<h2>Features</h2>${table(
                ['Feature', 'Activity', 'Errors'],
                b.features
                  .map((f) => ({ f, n: featureTotals.get(f.id) ?? { activity: 0, errors: 0 } }))
                  .sort((x, y) => y.n.activity + y.n.errors - (x.n.activity + x.n.errors))
                  .map(({ f, n }) => `<tr><td class="clip">${esc(f.name)}</td><td class="n">${fmtCompact(n.activity)}</td><td class="n">${n.errors ? fmtCompact(n.errors) : '–'}</td></tr>`),
              )}`
            : ''
        }
      </section>`;
  }

  function liveHtml(pick: Pick, state: SimState) {
    if (pick.kind === 'store') {
      const creative = pick.id === 'store:creative';
      const brief = pick.id === 'store:brief';
      const inside = app.cargo?.idle(creative ? 1 : brief ? 2 : 0, state.t) ?? [];
      const byClient = new Map<string, number>();
      for (const item of inside) byClient.set(item.region ?? '', (byClient.get(item.region ?? '') ?? 0) + 1);
      const clients = [...byClient].sort((a, b) => b[1] - a[1]);
      return `<dl><dt>Inside now</dt><dd>${inside.length.toLocaleString('en-US')}</dd></dl>
        ${clients.length ? table(['Client', creative ? 'Creatives' : brief ? 'Briefs' : 'Concepts'], clients.map(([region, n]) => `<tr><td class="clip">${region && regionNames.has(region) ? `<a class="who" data-id="${esc(region)}">${esc(regionName(region))}</a>` : 'No client'}</td><td class="n">${n.toLocaleString('en-US')}</td></tr>`)) : ''}
        ${
          inside.length
            ? table(
                [creative ? 'Creative' : brief ? 'Brief' : 'Concept', 'Has', 'Idle since'],
                inside.slice(0, STORE_ROWS).map(
                  (item) =>
                    `<tr><td class="clip"><a class="who" data-id="${esc(item.id)}" data-tip="${esc(`${item.id.slice(item.id.indexOf(':') + 1)} · ${item.region && regionNames.has(item.region) ? regionName(item.region) : 'no client'}`)}">${esc(creative ? app.redact(item.name, item.region) : `${item.id.slice(item.id.indexOf(':') + 1)} ${app.redact(item.name, item.region)}`)}</a></td><td>${item.parts.map((type) => resourceGlyph(type)).join('')}${item.ads > 1 ? item.ads : ''}</td><td class="n">${esc(fmtDate(item.since))}</td></tr>`,
                ),
              )
            : ''
        }
        ${inside.length > STORE_ROWS ? `<p class="sub">and ${(inside.length - STORE_ROWS).toLocaleString('en-US')} more that went idle earlier</p>` : ''}`;
    }
    if (pick.kind === 'crowd') {
      const crowd = state.crowds.find((c) => c.id === pick.id);
      if (!crowd) return '<p class="sub">No one is grouped here at this moment in the replay.</p>';
      const inside = crowd.members
        ? crowd.members.map((id) => ({ id: id as string | null, name: people.get(id)?.name ?? label(id) }))
        : app.sim.applied(crowd.role, state.t).map((name) => ({ id: null as string | null, name }));
      inside.sort((a, b) => a.name.localeCompare(b.name));
      return `<dl><dt>Here now</dt><dd>${crowd.count.toLocaleString('en-US')}</dd></dl>
        ${
          inside.length
            ? table(['Name'], inside.map((one) => `<tr><td class="clip">${one.id ? `<a class="who" data-id="${esc(one.id)}">${esc(one.name)}</a>` : esc(one.name)}</td></tr>`))
            : '<p class="sub">Only the count is in this week\'s data, not the names.</p>'
        }`;
    }
    if (pick.kind === 'barn') {
      const inside = [...state.stabled].sort((a, b) => (a.next ?? Infinity) - (b.next ?? Infinity) || label(a.id).localeCompare(label(b.id)));
      return `<dl><dt>Inside now</dt><dd>${inside.length}</dd></dl>
        ${inside.length ? table(['Automation', 'Runs next'], inside.map((unit) => `<tr><td class="clip"><a class="who" data-id="${esc(unit.id)}">${esc(people.get(unit.id)?.name ?? label(unit.id))}</a></td><td class="n">${unit.next === null ? 'not again this week' : esc(fmtClock(unit.next))}</td></tr>`)) : ''}`;
    }
    if (pick.kind === 'unit') {
      const unit = state.units[layout.index.get(pick.id)!];
      const agents = state.agents.filter((m) => m.owner === pick.id);
      const tools = TOOLS.map((tool) => [tool, agents.filter((m) => m.tool === tool).length] as const).filter(([, n]) => n > 0);
      return `<dl>
        <dt>Holds now</dt><dd>${
          unit
            ? TYPES.filter((type) => unit.holding[type] > 0)
                .map((type) => `<a class="tc seek" data-held="${type}" data-tip="${unit.holding[type]} ${RESOURCE_LABELS[type]}${unit.holding[type] === 1 ? '' : 's'}, click for links">${resourceGlyph(type)}${unit.holding[type]}</a>`)
                .join('') || '–'
            : '–'
        }</dd>
        ${
          unit?.busy
            ? `<dt>Right now</dt><dd>${
                unit.busy === 'ooo'
                  ? 'out of office'
                  : `in a meeting${(() => {
                      const meeting = state.meetings.find((m) => m.members.some((member) => member.id === pick.id));
                      return meeting ? ` with ${meeting.members.length - 1} ${meeting.members.length === 2 ? 'other' : 'others'}` : '';
                    })()}`
              }</dd>`
            : ''
        }
        ${cash() ? `<dt>Agents running now</dt><dd>${agents.length}${agents.length ? ` · ${agents.filter((m) => m.active).length} working` : ''}</dd>` : ''}
        ${cash() && tools.length ? `<dt></dt><dd>${tools.map(([tool, n]) => `<span class="tc">${TOOL_LABELS[tool]} ${n}</span>`).join('')}</dd>` : ''}
      </dl>`;
    }
    if (pick.kind === 'region') {
      const counter = state.counters.find((c) => c.region === pick.id);
      const all = state.trophies.filter((t) => t.region === pick.id);
      const tally = (kind: string) => all.reduce((n, t) => n + (t.kind === kind ? (t.count ?? 1) : 0), 0);
      const trophies = all.filter((t) => !t.count);
      const winners = trophies.filter((t) => t.kind === 'winning_ad');
      const launched = trophies.filter((t) => t.kind === 'creative');
      const camp = regions.get(pick.id)?.kind === 'recruiting' ? state.applicants : null;
      const spent = Object.entries(counter?.expenses ?? {}).filter(([, totals]) => Object.keys(totals).length);
      const stars = (list: typeof trophies, filled: boolean) =>
        list.length
          ? `<p class="list">${list
              .map((t) => `${glyph('star', filled ? COLORS.trophy : COLORS.bg, filled ? null : COLORS.trophy, 1.5)} ${esc(app.redact(t.name, pick.id))}${t.unit && people.has(t.unit) ? ` · ${who(t.unit)}` : ''}${traces.from(t.id)}`)
              .join('<br>')}</p>`
          : '';
      const held: PerResource = zero();
      layout.units.forEach((u, i) => {
        if (u.region !== pick.id || !state.units[i]) return;
        for (const type of TYPES) held[type] += state.units[i].holding[type];
      });
      return `<dl>
        ${cash() ? `<dt>Ad spend so far</dt><dd>${counter ? figures(counter.adSpend) : '–'}</dd>` : ''}
        ${
          cash() && counter?.goal
            ? `<dt>${esc(costLabel(counter.goal.metric))}${counter.goal.target !== null ? ' / goal' : ''}</dt><dd>${
                esc(fmtCostPer(counter.adSpend, counter.conversions, counter.goal.target)) || '–'
              }</dd>`
            : ''
        }
        ${cash() ? `<dt>Fees so far</dt><dd>${counter ? figures(counter.feeRevenue) : '–'}</dd>` : ''}
        ${cash() && counter && Object.keys(counter.clientRevenue).length ? `<dt>Client revenue so far</dt><dd>${figures(counter.clientRevenue)}</dd>` : ''}
        <dt>Tokens so far</dt><dd>${counter && counter.tokens > 0 ? fmtCompact(Math.round(counter.tokens)) : '–'}</dd>
        <dt>Held now</dt><dd>${byType(held)}</dd>
        <dt>Active now</dt><dd>${counter ? byType(counter.active) : '–'}</dd>
        <dt>Inactive now</dt><dd>${counter ? byType(counter.inactive) : '–'}</dd>
        <dt>Made so far</dt><dd>${counter ? byType(counter.made) : '–'}</dd>
        ${camp ? RECRUIT_STAGES.map((name, i) => `<dt>${esc(name)}</dt><dd>${camp.stages[i] ?? 0}</dd>`).join('') + `<dt>Hired this week</dt><dd>${camp.hired}</dd><dt>Passed on this week</dt><dd>${camp.passed}</dd>` : ''}
        ${!cash() ? '' : spent.map(([label, totals]) => `<dt>Spent on ${esc(label)}</dt><dd>${figures(totals)}</dd>`).join('')}
        ${!cash() ? '' : Object.entries(counter?.usage ?? {}).filter(([, totals]) => Object.keys(totals).length).map(([label, totals]) => `<dt>${esc(label)} usage, paid through ${esc(buildings.get(paidBy.get(label) ?? '')?.name ?? 'bills')}</dt><dd>${figures(totals)}</dd>`).join('')}
        <dt>Winning ads so far</dt><dd>${tally('winning_ad')}</dd>
        <dt>Creatives launched so far</dt><dd>${tally('creative')}</dd>
        <dt>Client winners so far</dt><dd>${tally('client_winner')}</dd>
      </dl>
      ${winners.length ? `<h2>Winning ads this week</h2>${stars(winners, true)}` : ''}
      ${launched.length ? `<h2>Creatives launched this week</h2>${stars(launched, false)}` : ''}`;
    }
    if (pick.kind === 'building') {
      const b = buildings.get(pick.id);
      return b && bills.has(b.id) && cash() ? billsHtml(b, state) : '';
    }
    return '';
  }

  const head = document.getElementById('panel-head')!;
  const pickable = app.library.length > 1;
  const paintHead = () => {
    const viewing = app.replay;
    head.innerHTML = `
      <header>
        <h1>${pickable ? `${fmtDate(app.start)} to ${fmtDate(app.end)} · ${app.library.length} weeks` : weekOf(data.window)}</h1>
        ${
          pickable && viewing
            ? `<p class="week"><button id="replay-open" title="Jump to a week" aria-haspopup="listbox" aria-expanded="false">${weekOf(viewing)} <span aria-hidden="true">▾</span></button></p>
        <div id="replays" role="listbox" hidden>${app.library
          .map((entry) => `<button role="option" data-replay="${esc(entry.id)}" aria-selected="${entry.id === viewing.id}"${entry.id === viewing.id ? ' class="on"' : ''}>${weekOf(entry)}</button>`)
          .join('')}</div>`
            : ''
        }
        <p class="sub">${fmtClock(data.window.start)} to ${fmtClock(data.window.end)}</p>
        <p class="sub ${app.source}">${
          app.source === 'real'
            ? `${esc(data.sources.map((name) => SOURCE_LABELS[name]).join(', '))} data from ${app.paged ? `data/library, ${app.library.length === 1 ? 'one week' : `${app.library.length} weeks loaded a week at a time`}` : 'data/replay.json'}`
            : 'Synthetic fixture, not real data'
        }</p>
      </header>`;
  };
  paintHead();

  const tip = document.createElement('div');
  tip.id = 'tip';
  tip.hidden = true;
  document.body.append(tip);
  root.addEventListener('pointermove', (event) => {
    const target = event.target as Element;
    const text = (target.closest<HTMLElement>('.tc[data-tip]') ?? target.closest<HTMLElement>('[data-tip]'))?.dataset.tip;
    tip.hidden = !text;
    if (!text) return;
    tip.textContent = text;
    tip.style.left = `${clampTo(event.clientX - tip.offsetWidth / 2, 4, window.innerWidth - tip.offsetWidth - 4)}px`;
    tip.style.top = `${Math.max(4, event.clientY - tip.offsetHeight - 10)}px`;
  });
  root.addEventListener('pointerleave', () => {
    tip.hidden = true;
  });

  if (pickable) {
    const setReplays = (open: boolean) => {
      const list = document.getElementById('replays');
      if (!list) return;
      list.hidden = !open;
      document.getElementById('replay-open')?.setAttribute('aria-expanded', String(open));
    };
    head.addEventListener('click', (event) => {
      const target = event.target as HTMLElement;
      if (target.closest('#replay-open')) return setReplays(!!document.getElementById('replays')?.hidden);
      const id = target.closest<HTMLElement>('[data-replay]')?.dataset.replay;
      if (!id) return;
      setReplays(false);
      app.open(id);
    });
    document.addEventListener('pointerdown', (event) => {
      if (!head.contains(event.target as Node)) setReplays(false);
    });
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') setReplays(false);
    });
  }

  const searchInput = document.getElementById('search-input') as HTMLInputElement;
  const searchResults = document.getElementById('search-results')!;
  const REGION_KINDS: Record<string, string> = { internal: 'region', client: 'client region', unmapped: 'region', recruiting: 'region' };
  const listed = (): { pick: Pick; name: string; sub: string; rank: number; text?: string }[] => [
    ...layout.regions.map((r) => ({ pick: { kind: 'region' as const, id: r.id }, name: app.regionName(r.id, r.name), sub: REGION_KINDS[r.kind] ?? 'region', rank: 0 })),
    ...layout.buildings.map((b) => ({ pick: { kind: 'building' as const, id: b.id }, name: b.name, sub: 'structure', rank: 1 })),
    ...layout.units.map((u) => {
      const person = people.get(u.id);
      const place = (person?.group && groupNames.get(person.group)) ?? (regionNames.has(u.region) ? regionName(u.region) : '');
      return { pick: { kind: 'unit' as const, id: u.id }, name: u.name, sub: [place, u.kind].filter(Boolean).join(' · '), rank: 2 };
    }),
    ...traces.entries(),
  ];
  let entries = listed();
  let hits: typeof entries = [];
  let hitAt = 0;

  function paintHits() {
    const query = searchInput.value.trim();
    searchResults.hidden = !query;
    searchResults.innerHTML = hits.length
      ? hits
          .map(
            (hit, i) =>
              `<button class="hit${i === hitAt ? ' on' : ''}" data-i="${i}"><span>${esc(hit.name)}</span><small>${esc(hit.sub)}</small></button>`,
          )
          .join('')
      : '<p class="none">No match</p>';
  }

  function search() {
    const words = searchInput.value.toLowerCase().split(/\s+/).filter(Boolean);
    hits = [];
    hitAt = 0;
    if (words.length) {
      const first = words[0];
      const scored: { entry: (typeof entries)[number]; score: number }[] = [];
      for (const entry of entries) {
        const name = entry.name.toLowerCase();
        const text = entry.text ? entry.text.toLowerCase() : name;
        if (!words.every((word) => text.includes(word))) continue;
        const score = name.startsWith(first) ? 0 : name.split(/[^a-z0-9]+/).some((part) => part.startsWith(first)) ? 1 : 2;
        scored.push({ entry, score });
      }
      scored.sort((a, b) => a.score - b.score || a.entry.rank - b.entry.rank || a.entry.name.localeCompare(b.entry.name));
      hits = scored.slice(0, 12).map((s) => s.entry);
    }
    paintHits();
  }

  function inspect(i: number) {
    const hit = hits[i];
    if (!hit) return;
    searchInput.value = '';
    search();
    searchInput.blur();
    app.pick(hit.pick);
  }

  searchInput.addEventListener('input', search);
  searchInput.addEventListener('keydown', (event) => {
    event.stopPropagation();
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (!hits.length) return;
      hitAt = (hitAt + (event.key === 'ArrowDown' ? 1 : hits.length - 1)) % hits.length;
      paintHits();
    } else if (event.key === 'Enter') {
      inspect(hitAt);
    } else if (event.key === 'Escape') {
      searchInput.value = '';
      search();
      searchInput.blur();
    }
  });
  searchResults.addEventListener('click', (event) => {
    const el = (event.target as HTMLElement).closest<HTMLElement>('.hit');
    if (el) inspect(Number(el.dataset.i));
  });

  let shownLive = '';
  function render(pick: Pick | null) {
    const card = !pick ? '' : pick.kind === 'trace' ? traces.card(pick.id) : pick.kind === 'barn' ? barnCard() : pick.kind === 'store' ? storeCard(pick.id) : pick.kind === 'crowd' ? crowdCard(pick.id) : pick.kind === 'unit' ? unitCard(pick.id) : pick.kind === 'region' ? regionCard(pick.id) : buildingCard(pick.id);
    body.innerHTML = `
      ${card}
      ${traces.list()}
      ${staticHtml}`;
    shownLive = '';
    refresh();
    for (const el of root.querySelectorAll<HTMLElement>('.who')) {
      el.classList.toggle('on', el.dataset.id === pick?.id);
    }
  }

  function refresh() {
    const pick = app.view.picked;
    const state = app.state;
    if (!pick || !state) return;
    const html = liveHtml(pick, state);
    if (html === shownLive) return;
    const el = document.getElementById('live');
    if (!el) return;
    shownLive = html;
    el.innerHTML = html;
  }

  root.addEventListener('click', (event) => {
    const target = event.target as HTMLElement;
    if (target.id === 'clear') return app.pick(null);
    const id = target.closest<HTMLElement>('.who')?.dataset.id;
    if (id) app.select(id);
  });

  app.onSelect((pick) => {
    render(pick);
    root.scrollTop = 0;
    setPanel(!!pick);
  });
  app.onRepick(() => setPanel(true));
  app.onChunk(() => {
    derive();
    staticHtml = metricsHtml();
    paintHead();
    render(app.view.picked);
  });
  let masked = `${app.view.show.regions}|${cash()}`;
  app.onFrame(() => {
    const now = `${app.view.show.regions}|${cash()}`;
    if (now !== masked) {
      masked = now;
      entries = listed();
      staticHtml = metricsHtml();
      render(app.view.picked);
      traces.repaint();
    }
    refresh();
  });
  panelOpen = !!app.view.picked || params.get('panel') === 'open';
  place();
  render(app.view.picked);
}
