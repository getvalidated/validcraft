import { INTERNAL_REGION, type Building, type EventKind, type ResourceType } from '../../../src/schema';

export interface Row {
  t: number;
  email: string | null;
  event: string;
  params: Record<string, string | number | boolean>;
}

export interface App {
  name: string;
  app: string;
  events: string[];
  keep: string[];
  filters?: string;
}

type Add = (
  kind: EventKind,
  resource: ResourceType | null,
  t: number,
  who: string | null,
  building: Building,
  slug: string,
  name: string,
  rest?: { id?: string; from?: string; to?: string; hint?: string | null },
) => boolean;

const MEET_ACTIONS: Record<string, [EventKind, string, string]> = {
  presentation_started: ['use', 'screen-shares', 'Screen shares'],
  send_chat_everyone: ['comment', 'call-chat', 'In-call chat'],
  reaction_sent: ['comment', 'call-reactions', 'Reactions'],
  recording_activity: ['use', 'recordings', 'Recordings'],
  transcription_activity: ['use', 'transcripts', 'Transcripts'],
  smart_notes_session_started: ['use', 'gemini-notes', 'Gemini notes'],
};

const DRIVE_ACTIONS: Record<string, [EventKind, string, string]> = {
  change_user_access: ['edit', 'shares', 'Shares'],
  change_document_visibility: ['edit', 'shares', 'Shares'],
  rename: ['edit', 'renames', 'Renames'],
  move: ['edit', 'moves', 'Moves'],
  trash: ['edit', 'trash', 'Trash'],
  delete: ['edit', 'trash', 'Trash'],
  copy: ['create', 'copies', 'Copies'],
};

const CHAT_ACTIONS: Record<string, [EventKind, string, string]> = {
  reaction_added: ['comment', 'reactions', 'Reactions'],
  message_edited: ['edit', 'edits', 'Edits'],
  attachment_upload: ['create', 'attachments', 'Attachments'],
};

const CALENDAR_ACTIONS: Record<string, [EventKind, string, string]> = {
  create_event: ['create', 'new-events', 'New events'],
  change_event_start_time: ['edit', 'reschedules', 'Reschedules'],
  change_event_guest_response: ['comment', 'rsvps', 'RSVPs'],
  add_event_guest: ['edit', 'guests', 'Guest lists'],
  remove_event_guest: ['edit', 'guests', 'Guest lists'],
  change_event_title: ['edit', 'details', 'Details'],
  change_event_location: ['edit', 'details', 'Details'],
  change_event_attachments: ['edit', 'details', 'Details'],
  delete_event: ['edit', 'cancellations', 'Cancellations'],
};

export const MORE_APPS: App[] = [
  { name: 'meet', app: 'meet', events: Object.keys(MEET_ACTIONS), keep: ['conference_id', 'identifier', 'identifier_type', 'is_external', 'streaming_session_state'] },
  { name: 'drive', app: 'drive', events: Object.keys(DRIVE_ACTIONS), keep: ['doc_id', 'doc_type', 'primary_event', 'target_user', 'visibility'], filters: 'primary_event==true' },
  { name: 'chat', app: 'chat', events: Object.keys(CHAT_ACTIONS), keep: ['conversation_type', 'room_id', 'message_id'] },
  { name: 'calendar', app: 'calendar', events: Object.keys(CALENDAR_ACTIONS), keep: ['event_id', 'organizer_calendar_id', 'event_guest', 'event_response_status', 'api_kind'] },
];

export const MAIL_SHAPE = 2;

export const mailCell = (inside: boolean, reply: boolean): [string, string] =>
  inside ? (reply ? ['replies', 'Replies to contacts'] : ['sent', 'Sent to contacts']) : reply ? ['replies-in', 'Replies from contacts'] : ['received', 'From contacts'];

const CALENDAR: Building = { id: 'google-calendar', region: INTERNAL_REGION, name: 'Google Calendar', resource: 'booking' };
const SERIES = /_\d{8}(T\d{6}Z)?$/;

export function convertActions(opts: {
  load: (...parts: string[]) => Row[];
  add: Add;
  staff: (email: string | null) => string | null;
  buildings: { meet: Building; docs: Building; chat: Building };
}) {
  const { load, add, staff, buildings } = opts;
  const counts: Record<string, number> = {};
  const seen = new Set<string>();
  const once = (key: string) => !seen.has(key) && !!seen.add(key);
  const note = (name: string, shown: boolean) => {
    if (shown) counts[name] = (counts[name] ?? 0) + 1;
  };
  const text = (value: unknown) => String(value ?? '').toLowerCase();

  for (const [event, [kind, slug, name]] of Object.entries(MEET_ACTIONS)) {
    for (const row of load('meet', event)) {
      const email = row.email ?? (row.params.identifier_type === 'email_address' ? text(row.params.identifier) : null);
      const conference = String(row.params.conference_id ?? '');
      if (!conference || (row.params.streaming_session_state !== undefined && row.params.streaming_session_state !== 'starting')) continue;
      note(name, add(kind, 'call', row.t, staff(email), buildings.meet, slug, name, { id: `meet:${conference}:${email}` }));
    }
  }

  for (const [event, [kind, slug, name]] of Object.entries(DRIVE_ACTIONS)) {
    for (const row of load('drive', event)) {
      const doc = String(row.params.doc_id ?? '');
      if (!doc || row.params.primary_event === false || row.params.doc_type === 'folder') continue;
      const target = event === 'change_user_access' ? staff(text(row.params.target_user) || null) : null;
      const who = staff(row.email);
      if (target && who && target !== who) {
        note('Shares to a teammate', add('send', 'doc', row.t, who, buildings.docs, slug, name, { id: `gdoc:${doc}`, from: who, to: target }));
      } else {
        note(name, add(kind, 'doc', row.t, who, buildings.docs, slug, name, { id: `gdoc:${doc}` }));
      }
    }
  }

  for (const [event, [kind, slug, name]] of Object.entries(CHAT_ACTIONS)) {
    for (const row of load('chat', event)) {
      const room = String(row.params.room_id ?? '');
      note(name, add(kind, 'chat', row.t, staff(row.email), buildings.chat, slug, name, room ? { id: `gchat:${room}:${row.params.message_id ?? row.t}` } : {}));
    }
  }

  const minute = (t: number) => Math.floor(t / 60_000);
  const made = new Set<string>();
  for (const row of load('calendar', 'create_event')) {
    for (const d of [-1, 0, 1]) made.add(`${row.email}|${String(row.params.event_id ?? '').replace(SERIES, '')}|${minute(row.t) + d}`);
  }
  for (const [event, [kind, slug, name]] of Object.entries(CALENDAR_ACTIONS)) {
    for (const row of load('calendar', event)) {
      const id = String(row.params.event_id ?? '').replace(SERIES, '');
      if (slug === 'guests' && made.has(`${row.email}|${id}|${minute(row.t)}`)) continue;
      const who = staff(row.email);
      const organizer = staff(text(row.params.organizer_calendar_id) || null);
      const guest = text(row.params.event_guest);
      if (!id || !who || row.params.api_kind === 'api_v3' || !once(`${event}|${who}|${id}|${guest}|${Math.floor(row.t / 60_000)}`)) continue;
      if (event === 'change_event_guest_response' && (who === organizer || staff(guest) !== who)) continue;
      const to = kind === 'comment' && organizer && organizer !== who ? organizer : undefined;
      note(name, add(kind, 'booking', row.t, who, CALENDAR, slug, name, { id: `gcal:${id}`, ...(to ? { to } : {}) }));
    }
  }

  return `${Object.entries(counts)
    .sort((a, b) => b[1] - a[1])
    .map(([name, n]) => `${n} ${name.toLowerCase()}`)
    .join(', ') || 'none'}`;
}
