import type { Feature } from '../../../src/schema';
import type { RawHistory } from './convert';

export const ACTIONS: Record<string, string> = {
  started: 'In progress',
  review: 'In review',
  revisions: 'Revisions',
  blocked: 'Blocked',
  queued: 'Queued',
  canceled: 'Canceled',
  delegated: 'Delegated to agents',
  archived: 'Archived',
  'sub-issues': 'Sub-issues',
  relations: 'Relations',
  labels: 'Labels',
  text: 'Title and description',
  planning: 'Planning',
  attachments: 'Attachments',
  'customer-requests': 'Customer requests',
  reactions: 'Reactions',
  resolved: 'Resolved threads',
};

const STATUS: [RegExp, string][] = [
  [/revision/i, 'revisions'],
  [/review|sign.?off|approv/i, 'review'],
  [/block|hold/i, 'blocked'],
];

export const featureId = (slug: string) => `linear/${slug}`;

export const featuresOf = (ids: Iterable<string>): Feature[] =>
  [...new Set(ids)]
    .filter((id) => id.startsWith('linear/') && id.slice('linear/'.length) in ACTIONS)
    .sort()
    .map((id) => ({ id, building: 'linear', name: ACTIONS[id.slice('linear/'.length)] }));

function statusOf(state: { type: string; name?: string | null }) {
  if (state.type === 'completed') return null;
  if (state.type === 'canceled') return 'canceled';
  if (state.type !== 'started') return 'queued';
  return STATUS.find(([test]) => test.test(state.name ?? ''))?.[1] ?? 'started';
}

export function actionOf(h: RawHistory): string | null {
  const status = h.toState && (h.fromState?.type !== h.toState.type || h.fromState?.name !== h.toState.name) ? statusOf(h.toState) : null;
  if (status) return status;
  if (h.toDelegate || h.fromDelegate) return 'delegated';
  if (h.archived || h.trashed || h.autoArchived || h.autoClosed) return 'archived';
  if (h.fromParent || h.toParent) return 'sub-issues';
  if (h.relationChanges?.length) return 'relations';
  if (h.addedLabels?.length || h.removedLabels?.length) return 'labels';
  if (h.toTitle || h.updatedDescription) return 'text';
  if (
    h.fromCycle || h.toCycle || h.fromProject || h.toProject || h.fromProjectMilestone || h.toProjectMilestone ||
    h.fromDueDate || h.toDueDate || h.fromTeam || h.toTeam ||
    (h.fromPriority ?? null) !== (h.toPriority ?? null) || (h.fromEstimate ?? null) !== (h.toEstimate ?? null)
  ) {
    return 'planning';
  }
  if (h.attachment) return 'attachments';
  if (h.customerNeedId) return 'customer-requests';
  return null;
}

export const mentionsIn = (body: string) => [...body.matchAll(/(?<![\w.])@([A-Za-z0-9_]+)/g)].map((m) => m[1].toLowerCase());
