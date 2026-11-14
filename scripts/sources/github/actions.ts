import type { Feature, SourceLink } from '../../../src/schema';

export const ACTIONS = {
  HeadRefForcePushedEvent: 'force-pushes',
  RenamedTitleEvent: 'titles',
  LabeledEvent: 'labels',
  UnlabeledEvent: 'labels',
  ReadyForReviewEvent: 'ready-for-review',
  ConvertToDraftEvent: 'back-to-draft',
  ReviewDismissedEvent: 'dismissed-reviews',
  AssignedEvent: 'assignees',
  UnassignedEvent: 'assignees',
  AutoMergeEnabledEvent: 'auto-merge',
} as const;

export const REVIEWS: Record<string, string> = {
  APPROVED: 'approvals',
  CHANGES_REQUESTED: 'changes-requested',
  COMMENTED: 'reviews',
  DISMISSED: 'reviews',
};

const NAMES: Record<string, string> = {
  'force-pushes': 'Force pushes',
  titles: 'Title edits',
  labels: 'Labels',
  'ready-for-review': 'Ready for review',
  'back-to-draft': 'Back to draft',
  'dismissed-reviews': 'Dismissed reviews',
  assignees: 'Assignees',
  'auto-merge': 'Auto-merge',
  approvals: 'Approvals',
  'changes-requested': 'Changes requested',
  reviews: 'Reviews',
  'inline-comments': 'Inline comments',
};

export const featureId = (slug: string) => `github/${slug}`;

export const featuresOf = (ids: Iterable<string>): Feature[] =>
  [...new Set(ids)]
    .filter((id) => id.startsWith('github/') && id.slice('github/'.length) in NAMES)
    .sort()
    .map((id) => ({ id, building: 'github', name: NAMES[id.slice('github/'.length)] }));

export const ticketsFirst = (links: SourceLink[]) =>
  links.map((l) => (l.child.startsWith('ticket:') && !l.parent.startsWith('ticket:') ? { parent: l.child, child: l.parent, t: l.t } : l));
