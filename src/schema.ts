export const SCHEMA_VERSION = 2;
export const INTERNAL_REGION = 'home';
export const UNMAPPED_REGION = 'unmapped';
export const WILD_REGION = 'wild';
export const RECRUIT_REGION = 'recruits';
export const RECRUIT_HINT = 'recruiting:grounds';
export const BAZAAR_REGION = 'bazaar';
export const LEAD_STAGES = ['Form submitted', 'Qualified', 'Call booked', 'Met', 'Proposal'];
export const RECRUIT_STAGES = ['Applied', 'Take-home', 'Screen', 'Tech screen', 'Onsite', 'Offer'];
export const NO_SHOW = -1;
export const DREAMING = -2;
export const CRAFTS = ['ranger', 'knight', 'wizard'] as const;
export const PASSED = -1;
export const HIRED = -2;
export const TRACE_STAGES = ['client_winner', 'concept', 'brief', 'board', 'asset', 'edit', 'review', 'row', 'ad', 'winner'] as const;

export type SourceName = 'linear' | 'slack' | 'notion' | 'github' | 'calendar' | 'temporal' | 'sentry' | 'mixpanel' | 'mcp' | 'outputs' | 'sessions' | 'money' | 'ashby' | 'spend' | 'platform' | 'workspace' | 'outreach' | 'ops';
export type ResourceType = 'ticket' | 'page' | 'thread' | 'pr' | 'analysis' | 'embedding' | 'taxonomy' | 'row' | 'video' | 'campaign' | 'adset' | 'ad' | 'resume' | 'setting' | 'report' | 'bill' | 'email' | 'call' | 'doc' | 'chat' | 'image' | 'board' | 'review' | 'comment' | 'rival' | 'post' | 'trend' | 'outreach' | 'booking' | 'incident' | 'deploy' | 'build' | 'assignment' | 'invite' | 'ambassador' | 'lead' | 'referral' | 'client_winner';
export type ResourceStatus = 'active' | 'inactive';
export type EventKind = 'create' | 'send' | 'assign' | 'comment' | 'done' | 'edit' | 'bulk' | 'use' | 'run' | 'error' | 'status';
export type UnitKind = 'person' | 'client' | 'automation' | 'system' | 'prospect' | 'recruit' | 'ambassador';
export type RegionKind = 'internal' | 'client' | 'unmapped' | 'recruiting' | 'bazaar';
export type SessionTool = 'coding_agent' | 'chat' | 'cowork' | 'scheduled' | 'other';
export type MeasureName = 'ad_spend' | 'own_spend' | 'fee_revenue' | 'tokens' | 'conversions' | 'expense' | 'client_revenue';
export type ArtifactKind = 'winning_ad' | 'creative' | 'client_winner';
export type BusyKind = 'meeting' | 'ooo';
export type TraceStage = (typeof TRACE_STAGES)[number];

export interface Window { start: number; end: number }

export interface Region { id: string; kind: RegionKind; name: string; since?: number }
export interface Group { id: string; region: string; name: string }
export interface Building { id: string; region: string; name: string; resource: ResourceType | null }
export interface Feature { id: string; building: string; name: string }
export interface Unit {
  id: string;
  kind: UnitKind;
  name: string;
  region: string;
  group: string | null;
  since?: number;
  until?: number;
  into?: string;
  stages?: [number, number][];
  calls?: string[];
  visits?: [number, string][];
  role?: 'wizard' | 'ranger' | 'knight';
  origin?: string;
}

export interface Session {
  id: string;
  owner: string;
  tool: SessionTool;
  start: number;
  end: number;
  parent: string | null;
  tokens: number | null;
  active: [number, number][];
}

export interface Holding {
  resource: ResourceType;
  resourceId: string;
  holder: string | null;
  building: string;
  t?: number;
}

export interface Applicants {
  base: number[];
  crafts?: number[];
  moves: [number, number, number, number?][];
  visits: [number, number, string][];
  people?: [name: string, craft: number, from: number, until: number | null][];
}

export interface Stock {
  resource: ResourceType;
  status: ResourceStatus;
  count: number;
  region: string | null;
}

export interface ReplayEvent {
  kind: EventKind;
  t: number;
  source: SourceName;
  actor: string;
  via: string | null;
  resource: ResourceType | null;
  resourceId: string | null;
  building: string | null;
  from: string | null;
  to: string | null;
  isReturn: boolean;
  count: number;
  region: string | null;
  feature?: string | null;
  status?: ResourceStatus | null;
  ours?: number;
  parent?: string;
  amount?: number;
  currency?: string;
  trace?: string;
}

export interface Measure {
  name: MeasureName;
  start: number;
  end: number;
  value: number;
  currency: string | null;
  region: string | null;
  unit: string | null;
  label?: string;
  paidBy?: string;
}

export interface Goal {
  region: string | null;
  metric: string;
  target: number | null;
}

export interface Artifact {
  id: string;
  kind: ArtifactKind;
  t: number;
  name: string;
  region: string | null;
  unit: string | null;
}

export interface TraceNode {
  key: string;
  on?: number[];
  parent: string | null;
  stage: TraceStage;
  t: number;
  name: string | null;
  url?: string;
}

export interface TraceStep {
  t: number;
  stage: TraceStage;
  kind: EventKind;
  source: SourceName;
  key: string;
  actor: string | null;
  via: string | null;
  building: string | null;
}

export interface Trace {
  id: string;
  name: string;
  region: string | null;
  t: number;
  stage: TraceStage;
  hands: string[];
  nodes: TraceNode[];
  steps: TraceStep[];
  from?: string;
}

export interface Busy {
  unit: string;
  kind: BusyKind;
  start: number;
  end: number;
  meeting: string | null;
}

export interface PersonStats {
  id: string;
  in: number;
  out: number;
  returnsIn: number;
  returnsOut: number;
  holdMedianMs: number | null;
  holdP75Ms: number | null;
  holdSamples: number;
  assignsGiven: number;
  assignsReceived: number;
  creates: number;
  comments: number;
  done: number;
  edits: number;
  bulkEvents: number;
  bulkCovered: number;
}

export interface Weekly {
  totals: {
    handoffs: number;
    returns: number;
    returnShare: number;
    ticketsTouched: number;
    ticketsNoHandoff: number;
    bulkEvents: number;
    bulkCovered: number;
    activity: number;
    bulkShare: number;
  };
  byTeam: { team: string; handoffs: number; returns: number }[];
  byResource: { resource: ResourceType; sends: number; returns: number }[];
  people: PersonStats[];
  pairs: { from: string; to: string; count: number; returns: number }[];
  tickets: { issue: string; team: string; project: string | null; count: number }[];
  projects: { project: string; handoffs: number; returns: number; tickets: number }[];
  betweenHandoffs: { medianMs: number | null; p90Ms: number | null; samples: number };
}

export interface MetricRow {
  label: string;
  value: string;
  num: string;
  den: string;
  start: string;
  end: string;
  note: string;
}

export interface Metric {
  fn: string;
  name: string;
  unit: string;
  head: MetricRow | null;
  parts: { by: string; rows: MetricRow[] }[];
}

export interface RegionTotals {
  region: string;
  adSpend?: Record<string, number>;
  ownSpend?: Record<string, number>;
  feeRevenue?: Record<string, number>;
  clientRevenue?: Record<string, number>;
  conversions?: Record<string, number>;
  expenses?: Record<string, Record<string, number>>;
  usage?: Record<string, Record<string, number>>;
  tokens?: number;
  made?: Partial<Record<ResourceType, number>>;
  wins?: number;
  launches?: number;
  clientWins?: number;
}

export const CARRIED_STATS = ['assignsGiven', 'assignsReceived', 'creates', 'comments', 'done', 'edits', 'bulkEvents', 'bulkCovered'] as const;

export interface WeekClosing {
  bills?: Record<string, { source: SourceName; sums: Record<string, number> }>;
  features?: Record<string, [activity: number, errors: number]>;
  created?: Record<string, Record<string, number>>;
  people?: Record<string, number[]>;
}

export interface ReplayRef extends Window {
  id: string;
  binMs?: number;
  bins?: number[];
  totals?: RegionTotals[];
  closing?: WeekClosing;
}

export interface Replay {
  schemaVersion: 2;
  window: Window;
  sources: SourceName[];
  regions: Region[];
  groups: Group[];
  buildings: Building[];
  features?: Feature[];
  units: Unit[];
  sessions: Session[];
  initial: Holding[];
  events: ReplayEvent[];
  measures: Measure[];
  artifacts: Artifact[];
  goals?: Goal[];
  busy?: Busy[];
  stock?: Stock[];
  applicants?: Applicants;
  traces?: Trace[];
  weekly: Weekly | null;
  metrics?: Metric[];
  unmapped: { actors: number; clientHints: number };
}

export interface ActorRef {
  key: string;
  email: string | null;
  name: string | null;
  kind: UnitKind;
  groupHint: string | null;
  clientHint: string | null;
  external?: boolean;
}

export interface SourceEvent {
  kind: EventKind;
  t: number;
  actor: string;
  via: string | null;
  resource: ResourceType | null;
  resourceId: string | null;
  building: string | null;
  from: string | null;
  to: string | null;
  isReturn: boolean;
  count: number;
  clientHint: string | null;
  feature?: string | null;
  status?: ResourceStatus | null;
  ours?: number;
  parent?: string;
  amount?: number;
  currency?: string;
}

export interface SourceStock {
  resource: ResourceType;
  status: ResourceStatus;
  count: number;
  clientHint: string | null;
}

export interface SourceLink {
  parent: string;
  child: string;
  t: number;
  name?: string;
}

export interface SourceConcept {
  id: string;
  name: string;
  t: number;
  actor: string | null;
  clientHint: string | null;
  from?: string;
}

export interface SourceHolding {
  resource: ResourceType;
  resourceId: string;
  holder: string | null;
  building: string;
}

export interface SourceSession {
  id: string;
  owner: string;
  tool: SessionTool;
  start: number;
  end: number;
  parent: string | null;
  tokens: number | null;
  active: [number, number][];
}

export interface SourceMeasure {
  name: MeasureName;
  start: number;
  end: number;
  value: number;
  currency: string | null;
  clientHint: string | null;
  actor: string | null;
  label?: string;
  paidBy?: string;
}

export interface SourceGoal {
  clientHint: string | null;
  metric: string;
  target: number | null;
}

export interface SourceArtifact {
  id: string;
  kind: ArtifactKind;
  t: number;
  name: string;
  clientHint: string | null;
  actor: string | null;
}

export interface SourceBusy {
  actor: string;
  kind: BusyKind;
  start: number;
  end: number;
  meeting: string | null;
}

export interface SourceFile {
  schemaVersion: 2;
  source: SourceName;
  window: Window;
  actors: ActorRef[];
  buildings: Building[];
  features?: Feature[];
  events: SourceEvent[];
  initial: SourceHolding[];
  sessions: SourceSession[];
  measures: SourceMeasure[];
  artifacts: SourceArtifact[];
  goals?: SourceGoal[];
  busy?: SourceBusy[];
  stock?: SourceStock[];
  links?: SourceLink[];
  concepts?: SourceConcept[];
  urls?: Record<string, string>;
  ended?: { id: string; t: number }[];
}

export interface Registry {
  schemaVersion: 2;
  regions: Region[];
  groups: Group[];
  units: Unit[];
  identities: Record<string, string>;
  emails: Record<string, string>;
  clientHints: Record<string, string>;
  applicants?: Applicants;
}
