import type { ResourceType, SessionTool, SourceName, TraceStage, UnitKind } from './schema';
import type { PerResource } from './seam';

export const TYPES: ResourceType[] = ['ticket', 'page', 'thread', 'pr', 'analysis', 'embedding', 'taxonomy', 'row', 'video', 'campaign', 'adset', 'ad', 'resume', 'setting', 'report', 'bill', 'email', 'call', 'doc', 'chat', 'image', 'board', 'review', 'comment', 'rival', 'post', 'trend', 'outreach', 'booking', 'incident', 'deploy', 'build', 'assignment', 'invite', 'ambassador', 'lead', 'referral', 'client_winner'];
export const SOURCES: SourceName[] = ['linear', 'slack', 'notion', 'github', 'calendar', 'temporal', 'sentry', 'mixpanel', 'mcp', 'outputs', 'sessions', 'money', 'ashby', 'spend', 'platform', 'workspace', 'outreach', 'ops'];
export const TOOLS: SessionTool[] = ['coding_agent', 'chat', 'cowork', 'scheduled', 'other'];
const SHADE_STEPS = 5;

export const RESOURCE_COLORS: Record<ResourceType, string> = {
  ticket: '#56B4E9',
  page: '#009E73',
  thread: '#F0E442',
  pr: '#D55E00',
  analysis: '#B39DDB',
  embedding: '#4DD0E1',
  taxonomy: '#F48FB1',
  row: '#AED581',
  video: '#FF8A65',
  campaign: '#7986CB',
  adset: '#BCAAA4',
  ad: '#DCE775',
  resume: '#F3E9D2',
  setting: '#80CBC4',
  report: '#9CCC65',
  bill: '#EF9A9A',
  email: '#64B5F6',
  call: '#BA68C8',
  doc: '#4DB6AC',
  chat: '#FFD54F',
  image: '#FFB74D',
  board: '#A1887F',
  review: '#FFF176',
  comment: '#90CAF9',
  rival: '#E57373',
  post: '#F06292',
  trend: '#81C784',
  outreach: '#4FC3F7',
  booking: '#9575CD',
  incident: '#FF7043',
  deploy: '#26C6DA',
  build: '#90A4AE',
  assignment: '#C5E1A5',
  invite: '#CE93D8',
  ambassador: '#FFCC80',
  lead: '#E6EE9C',
  referral: '#F48FB1',
  client_winner: '#F23D4F',
};

export const RESOURCE_SHAPES: Record<ResourceType, 'square' | 'circle' | 'triangle' | 'pentagon' | 'hexagon' | 'diamond' | 'tag' | 'bar' | 'play' | 'flag' | 'trapezoid' | 'chevron' | 'sheet' | 'notch' | 'chart' | 'receipt' | 'envelope' | 'camera' | 'folder' | 'octagon' | 'peaks' | 'ell' | 'spark' | 'bubble' | 'shield' | 'heart' | 'arrow' | 'plane' | 'calendar' | 'bolt' | 'rocket' | 'bowtie' | 'pointer' | 'stub' | 'horn' | 'funnel' | 'gift' | 'star'> = {
  ticket: 'square',
  page: 'circle',
  thread: 'triangle',
  pr: 'pentagon',
  analysis: 'hexagon',
  embedding: 'diamond',
  taxonomy: 'tag',
  row: 'bar',
  video: 'play',
  campaign: 'flag',
  adset: 'trapezoid',
  ad: 'chevron',
  resume: 'sheet',
  setting: 'notch',
  report: 'chart',
  bill: 'receipt',
  email: 'envelope',
  call: 'camera',
  doc: 'folder',
  chat: 'octagon',
  image: 'peaks',
  board: 'ell',
  review: 'spark',
  comment: 'bubble',
  rival: 'shield',
  post: 'heart',
  trend: 'arrow',
  outreach: 'plane',
  booking: 'calendar',
  incident: 'bolt',
  deploy: 'rocket',
  build: 'bowtie',
  assignment: 'pointer',
  invite: 'stub',
  ambassador: 'horn',
  lead: 'funnel',
  referral: 'gift',
  client_winner: 'star',
};

export const RESOURCE_LABELS: Record<ResourceType, string> = {
  ticket: 'ticket',
  page: 'page',
  thread: 'thread',
  pr: 'pull request',
  analysis: 'analysis doc',
  embedding: 'embedding',
  taxonomy: 'taxonomy name',
  row: 'sheet row',
  video: 'video',
  campaign: 'campaign',
  adset: 'ad set',
  ad: 'ad',
  resume: 'resume',
  setting: 'client setting',
  report: 'report',
  bill: 'bill',
  email: 'email',
  call: 'call',
  doc: 'doc',
  chat: 'chat message',
  image: 'image',
  board: 'board',
  review: 'app review',
  comment: 'ad comment',
  rival: 'competitor ad',
  post: 'organic post',
  trend: 'trend video',
  outreach: 'outreach email',
  booking: 'booking',
  incident: 'incident',
  deploy: 'deploy',
  build: 'CI run',
  assignment: 'assignment',
  invite: 'invite',
  ambassador: 'ambassador',
  lead: 'lead',
  referral: 'referral',
  client_winner: 'client winner',
};

export const SOURCE_LABELS: Record<SourceName, string> = {
  linear: 'Linear',
  slack: 'Slack',
  notion: 'Notion',
  github: 'GitHub',
  calendar: 'Calendar',
  temporal: 'Temporal',
  sentry: 'Sentry',
  mixpanel: 'Mixpanel',
  mcp: 'MCP',
  outputs: 'Outputs',
  sessions: 'AI sessions',
  money: 'Money',
  ashby: 'Ashby',
  spend: 'Spend',
  platform: 'Platform',
  workspace: 'Workspace',
  outreach: 'Outreach',
  ops: 'Ops',
};

export const TOOL_LABELS: Record<SessionTool, string> = {
  coding_agent: 'coding agent',
  chat: 'chat',
  cowork: 'cowork',
  scheduled: 'scheduled',
  other: 'other',
};

export const COLORS = {
  bg: '#0B0E14',
  return: '#E69F00',
  bulk: '#CC79A7',
  neutral: '#7482A3',
  agent: '#E6EBF5',
  trophy: '#FFD166',
  moneyIn: '#81C784',
  moneyOut: '#EF9A9A',
  unit: '#AAB3C5',
  meeting: '#A78BFA',
  use: '#5EEAD4',
  error: '#FF5C5C',
  away: '#6B7385',
  trace: '#FF4FD8',
};

export const STAGE_COLORS: Record<TraceStage, string> = {
  client_winner: '#F23D4F',
  concept: '#9AA7C7',
  brief: '#6F9BEA',
  board: '#56B4E9',
  asset: '#3FC1C9',
  edit: '#48C78E',
  review: '#A6D854',
  row: '#E6D34A',
  ad: '#F0A04B',
  winner: '#FFD166',
};

export const ORIGIN_COLORS: Record<string, string> = {
  'Paid Meta': '#6FA8FF',
  'Paid TikTok': '#FF7FA3',
  'Paid Google': '#7BD88F',
  'Paid Unknown': '#B39DDB',
  'Paid Other': '#9FA8DA',
  'Website (no ad tag)': '#4DD0E1',
  'Rep Link': '#FFB74D',
  Event: '#FFE066',
  Referral: '#C5E1A5',
  Inbound: '#80CBC4',
  Outbound: '#F48FB1',
};
const ORIGINS = Object.keys(ORIGIN_COLORS);
const originRank = (origin: string) => (!origin ? ORIGINS.length + 1 : ORIGINS.includes(origin) ? ORIGINS.indexOf(origin) : ORIGINS.length);
export const byOrigin = (a: string, b: string) => originRank(a) - originRank(b) || a.localeCompare(b);
export const originColor = (origin?: string | null) => ORIGIN_COLORS[origin ?? ''] ?? UNIT_COLORS.prospect.edge;
export const originName = (origin?: string | null) => origin || 'No source';

export const UNIT_COLORS: Record<UnitKind, { fill: string; edge: string }> = {
  person: { fill: '#2C3854', edge: '#8FA3D6' },
  client: { fill: '#3A3350', edge: '#B9A6E0' },
  automation: { fill: '#33383F', edge: '#AAB3C5' },
  system: { fill: '#2F3238', edge: '#8A8F98' },
  prospect: { fill: '#4A3B28', edge: '#E3C48E' },
  recruit: { fill: '#4B2E2A', edge: '#F0A58F' },
  ambassador: { fill: '#4A3A1E', edge: '#FFCC80' },
};

type Lab = [number, number, number];

export const hex = (color: string) => parseInt(color.slice(1), 16);

const toLinear = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const toGamma = (c: number) => (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055);

function toLab(rgb: number): Lab {
  const r = toLinear(((rgb >> 16) & 255) / 255);
  const g = toLinear(((rgb >> 8) & 255) / 255);
  const b = toLinear((rgb & 255) / 255);
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}

function fromLab(L: number, a: number, b: number) {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  const ch = (v: number) => Math.round(255 * Math.min(1, Math.max(0, toGamma(v))));
  return (
    (ch(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s) << 16) |
    (ch(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s) << 8) |
    ch(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s)
  );
}

const labCache = new Map<number, Lab>();
function lab(rgb: number) {
  let value = labCache.get(rgb);
  if (!value) {
    value = toLab(rgb);
    labCache.set(rgb, value);
  }
  return value;
}

const MIX_STEPS = 32;
const mixCache = new Map<number, Map<number, number>>();

export function mix(from: number, to: number, k: number) {
  const step = Math.round(Math.min(1, Math.max(0, k)) * MIX_STEPS);
  if (step === 0) return from;
  if (step === MIX_STEPS) return to;
  const key = from * (MIX_STEPS + 1) + step;
  let row = mixCache.get(key);
  if (!row) {
    row = new Map();
    mixCache.set(key, row);
  }
  let value = row.get(to);
  if (value === undefined) {
    const p = lab(from);
    const q = lab(to);
    const s = step / MIX_STEPS;
    value = fromLab(p[0] + (q[0] - p[0]) * s, p[1] + (q[1] - p[1]) * s, p[2] + (q[2] - p[2]) * s);
    row.set(to, value);
  }
  return value;
}

export const TYPE_COLOR = Object.fromEntries(TYPES.map((type) => [type, hex(RESOURCE_COLORS[type])])) as Record<ResourceType, number>;

const TYPE_LAB = TYPES.map((type) => lab(TYPE_COLOR[type]));
const TYPE_CHROMA = TYPE_LAB.map(([, a, b]) => Math.hypot(a, b));
const SHADE_STEP = 0.05;
const SHADE_TOP = 0.93;

const SHADES = Object.fromEntries(TYPES.map((type) => [type, [] as number[]])) as Record<ResourceType, number[]>;
TYPES.forEach((type, i) => {
  const [L, a, b] = TYPE_LAB[i];
  const half = (SHADE_STEPS - 1) / 2;
  const shift = Math.min(0, SHADE_TOP - (L + half * SHADE_STEP));
  for (let step = 0; step < SHADE_STEPS; step++) {
    SHADES[type].push(step === half && shift === 0 ? TYPE_COLOR[type] : fromLab(L + shift + (step - half) * SHADE_STEP, a, b));
  }
});

export function shadeColor(type: ResourceType, shade: number) {
  return SHADES[type][((Math.round(shade) % SHADE_STEPS) + SHADE_STEPS) % SHADE_STEPS];
}

const BLEND_STEPS = 24;
const blendCache = new Map<string, number>();
const blendSteps = new Array<number>(TYPES.length).fill(0);

export function blendTypes(weights: PerResource) {
  let total = 0;
  for (const type of TYPES) total += Math.max(0, weights[type]);
  if (total <= 0) return hex(COLORS.neutral);
  let key = '';
  let sum = 0;
  for (let i = 0; i < TYPES.length; i++) {
    const q = Math.round((Math.max(0, weights[TYPES[i]]) / total) * BLEND_STEPS);
    blendSteps[i] = q;
    sum += q;
    key += String.fromCharCode(48 + q);
  }
  let value = blendCache.get(key);
  if (value === undefined) {
    let L = 0;
    let a = 0;
    let b = 0;
    let chroma = 0;
    for (let i = 0; i < TYPES.length; i++) {
      const k = blendSteps[i] / (sum || 1);
      L += k * TYPE_LAB[i][0];
      a += k * TYPE_LAB[i][1];
      b += k * TYPE_LAB[i][2];
      chroma += k * TYPE_CHROMA[i];
    }
    const mag = Math.hypot(a, b);
    const keep = mag > 1e-6 ? chroma / mag : 1;
    value = fromLab(L, a * keep, b * keep);
    blendCache.set(key, value);
  }
  return value;
}
