import type { SpritePart } from './sprites';
import type { ArtifactKind, BusyKind, EventKind, RegionKind, ResourceStatus, ResourceType, SessionTool, SourceName, UnitKind } from './schema';

export interface Point {
  x: number;
  y: number;
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export type PerResource = Record<ResourceType, number>;

export interface LayoutRegion {
  id: string;
  kind: RegionKind;
  name: string;
  rect: Rect;
  headcount: number;
  since?: number;
  foot: number;
  farm?: Rect;
}

export interface LayoutGroup {
  id: string;
  region: string;
  name: string;
  rect: Rect;
}

export interface LayoutFeature {
  id: string;
  building: string;
  name: string;
  rect: Rect;
  x: number;
  y: number;
}

export interface LayoutBuilding {
  id: string;
  region: string;
  name: string;
  resource: ResourceType | null;
  x: number;
  y: number;
  size: number;
  rect: Rect;
  features: LayoutFeature[];
}

export type UnitRole = 'townsfolk' | 'knight' | 'wizard' | 'ranger' | 'farmer' | 'chicken' | 'horse' | 'cow' | 'dog' | 'pig' | 'cat' | 'traveller' | 'recruit';

export interface LayoutUnit {
  id: string;
  index: number;
  kind: UnitKind;
  role: UnitRole;
  sprite?: SpritePart[];
  name: string;
  label: string;
  region: string;
  group: string | null;
  x: number;
  y: number;
  slots: Point[];
  palace?: boolean;
  since?: number;
  until?: number;
  into?: string;
  stages?: [number, number][];
  calls?: string[];
  visits?: [number, string][];
  spots?: Point[];
  origin?: string;
}

export interface Layout {
  regions: LayoutRegion[];
  groups: LayoutGroup[];
  buildings: LayoutBuilding[];
  features: LayoutFeature[];
  units: LayoutUnit[];
  index: Map<string, number>;
  bounds: Rect;
  unitRadius: number;
  strata?: { core: Rect; band: number; gap: number; top: number; height: number; jail: Rect; heaven: Rect };
  grounds?: { rect: Rect; yards: Rect[]; posts: Point[] };
  barn?: Point & { group: string };
  stores?: { concept: Point; creative: Point; brief: Point };
  square?: Rect;
}

export interface Tick {
  day: number;
  minute: number;
}

export interface UnitState {
  id: string;
  x: number;
  y: number;
  dx: number;
  dy: number;
  activity: number;
  holding: PerResource;
  busy: BusyKind | null;
  hidden?: boolean;
}

export interface CrowdState {
  id: string;
  members?: string[];
  kind: UnitKind;
  role: UnitRole;
  origin?: string;
  x: number;
  y: number;
  count: number;
}

export interface AgentState {
  id: string;
  owner: string;
  tool: SessionTool;
  parent: string | null;
  x: number;
  y: number;
  active: boolean;
  ageMs: number;
  remainingMs: number;
}

export type FlightKind = 'send' | 'assign' | 'spawn';

export interface Anchor {
  id: string;
  x: number;
  y: number;
}

export interface FlightState {
  kind: FlightKind;
  resource: ResourceType;
  resourceId: string;
  shade: number;
  from: Anchor;
  to: Anchor;
  x: number;
  y: number;
  progress: number;
  isReturn: boolean;
  via: string | null;
  trace?: string;
}

export interface RingState {
  kind: Exclude<EventKind, 'send' | 'assign' | 'use' | 'run' | 'error'>;
  at: string;
  actor: string;
  x: number;
  y: number;
  radius: number;
  alpha: number;
  progress: number;
  angle: number;
  count: number;
  resource: ResourceType | null;
  status: ResourceStatus | null;
  via: string | null;
  trace?: string;
}

export interface CounterState {
  region: string;
  adSpend: Record<string, number>;
  ownSpend: Record<string, number>;
  feeRevenue: Record<string, number>;
  clientRevenue: Record<string, number>;
  conversions: Record<string, number>;
  expenses: Record<string, Record<string, number>>;
  usage?: Record<string, Record<string, number>>;
  goal: { metric: string; target: number | null } | null;
  tokens: number;
  active: PerResource;
  inactive: PerResource;
  made: PerResource;
}

export interface ApplicantState {
  stages: number[];
  applied: number[];
  hired: number;
  passed: number;
}

export interface TrophyState {
  id: string;
  kind: ArtifactKind;
  name: string;
  region: string | null;
  unit: string | null;
  ageMs: number;
  count?: number;
}

export interface FeatureState {
  id: string;
  use: number;
  run: number;
  error: number;
  total: number;
  errors: number;
}

export interface PulseState {
  source: SourceName;
  feature: string;
  from: Anchor;
  to: Anchor;
  x: number;
  y: number;
  progress: number;
  count: number;
  via: string | null;
}

export interface MeetingState {
  id: string;
  x: number;
  y: number;
  size: 'small' | 'medium' | 'large';
  radius: number;
  alpha: number;
  members: Anchor[];
}

export interface SimState {
  t: number;
  speed: number;
  lifeMs: number;
  tauMs: number;
  tick: Tick;
  units: UnitState[];
  crowds: CrowdState[];
  stabled: { id: string; next: number | null }[];
  agents: AgentState[];
  flights: FlightState[];
  rings: RingState[];
  counters: CounterState[];
  trophies: TrophyState[];
  applicants: ApplicantState | null;
  meetings: MeetingState[];
  features: FeatureState[];
  pulses: PulseState[];
  inMotion: boolean;
}

export interface LaneInfo {
  key: string;
  from: string;
  to: string;
  count: PerResource;
  total: number;
  returns: number;
}

export interface Partners {
  out: LaneInfo[];
  in: LaneInfo[];
  ids: Set<string>;
}

export interface Sim {
  lanes: LaneInfo[];
  state(t: number, speed: number): SimState;
  lifeMs(speed: number): number;
  inMotion(t: number, speed: number): boolean;
  prevEventTime(t: number): number;
  nextEventTime(t: number): number;
  bins(start: number, end: number, binMs: number): number[];
  partners(id: string): Partners;
  held(id: string, t: number): string[];
  applied(role: string, t: number): string[];
}
