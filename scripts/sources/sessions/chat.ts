import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { SourceSession, Window } from '../../../src/schema';
import {
  RAW,
  Skip,
  clampTimes,
  emailActor,
  iso,
  openState,
  pagesIn,
  parseTime,
  readPage,
  savePage,
  saveState,
  toSession,
  type Collected,
  type SkillUse,
} from './shared';

const DIR = path.join(RAW, 'chat');
const USERS_DIR = path.join(DIR, 'users');
const CONVERSATIONS_DIR = path.join(DIR, 'conversations');
const ZIP_PREFIXES = ['light_metadata-', 'conversations-'];
const PAGE = 500;
const CHARS_PER_TOKEN = 4;
const SKILL_PATH = /\/mnt\/skills\/(public|organization|user|private|examples)\/([a-zA-Z0-9_-]+)/g;

interface User {
  uuid: string;
  email: string;
}

interface Conversation {
  id: string;
  account: string;
  messages: [number, number][];
  skills?: { t: number; skill: string; unused: { scope: string; tool: string } }[];
  before: number | null;
  after: number | null;
}

const baseName = (url: string) => url.slice(url.lastIndexOf('/') + 1);

function blockChars(block: any): number {
  if (typeof block === 'string') return block.length;
  if (Array.isArray(block)) return block.reduce((sum, b) => sum + blockChars(b), 0);
  if (!block || typeof block !== 'object') return 0;
  if (block.type === 'text') return (block.text ?? '').length;
  if (block.type === 'thinking') return (block.thinking ?? '').length;
  if (block.type === 'tool_use') return block.input == null ? 0 : JSON.stringify(block.input).length;
  if (block.type === 'tool_result') return blockChars(block.content);
  return 0;
}

function messageChars(message: any): number {
  if (Array.isArray(message.content) && message.content.length) return blockChars(message.content);
  return (message.text ?? '').length;
}

function skillsIn(message: any, t: number) {
  const found = new Map<string, { t: number; skill: string; unused: { scope: string; tool: string } }>();
  for (const block of Array.isArray(message.content) ? message.content : []) {
    if (block?.type !== 'tool_use' || !block.input || typeof block.input !== 'object') continue;
    for (const value of Object.values(block.input)) {
      if (typeof value !== 'string') continue;
      for (const [, scope, skill] of value.matchAll(SKILL_PATH)) {
        if (!found.has(skill)) found.set(skill, { t, skill, unused: { scope, tool: String(block.name ?? '') } });
      }
    }
  }
  return [...found.values()];
}

function strip(conversation: any, window: Window): Conversation | null {
  const out: Conversation = {
    id: conversation?.uuid ?? '',
    account: conversation?.account?.uuid ?? '',
    messages: [],
    skills: [],
    before: null,
    after: null,
  };
  if (!out.id) return null;
  for (const message of conversation.chat_messages ?? []) {
    const t = parseTime(message?.created_at);
    if (!Number.isFinite(t)) continue;
    if (t < window.start) {
      if (out.before === null || t > out.before) out.before = t;
    } else if (t >= window.end) {
      if (out.after === null || t < out.after) out.after = t;
    } else {
      out.messages.push([t, messageChars(message)]);
      out.skills!.push(...skillsIn(message, t));
    }
  }
  return out.messages.length ? out : null;
}

async function* arrayItems(chunks: AsyncIterable<string>): AsyncGenerator<any> {
  let buf = '';
  let scanned = 0;
  let start = -1;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for await (const chunk of chunks) {
    buf += chunk;
    for (let i = scanned; i < buf.length; i++) {
      const c = buf.charCodeAt(i);
      if (inString) {
        if (escaped) escaped = false;
        else if (c === 92) escaped = true;
        else if (c === 34) inString = false;
      } else if (c === 34) {
        inString = true;
      } else if (c === 123 || c === 91) {
        if (depth === 1) start = i;
        depth++;
      } else if (c === 125 || c === 93) {
        depth--;
        if (depth === 1 && start >= 0) {
          yield JSON.parse(buf.slice(start, i + 1));
          start = -1;
        }
      }
    }
    buf = start >= 0 ? buf.slice(start) : '';
    scanned = buf.length;
    if (start >= 0) start = 0;
  }
}

async function* zipMember(zip: string, member: string): AsyncGenerator<any> {
  const child = spawn('unzip', ['-p', zip, member], { stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.setEncoding('utf8').on('data', (chunk) => (stderr += chunk));
  const closed = new Promise<number | null>((resolve, reject) => {
    child.on('error', reject);
    child.on('close', resolve);
  });
  closed.catch(() => {});
  let finished = false;
  try {
    yield* arrayItems(child.stdout.setEncoding('utf8'));
    finished = true;
  } finally {
    if (!finished) child.kill();
  }
  const code = await closed;
  if (code !== 0) throw new Error(`unzip ${member} exited ${code}: ${stderr.trim().slice(0, 300)}`);
}

async function pull(window: Window) {
  const local = process.env.CLAUDE_EXPORT ? path.resolve(process.env.CLAUDE_EXPORT) : null;
  if (!local) throw new Skip('CLAUDE_EXPORT is not set to a folder holding the zips of a Claude organization data export');
  if (!fs.existsSync(local)) throw new Skip(`no folder at ${local}`);
  let state = openState(DIR, window);
  if (state.snapshot !== local) {
    fs.rmSync(DIR, { recursive: true, force: true });
    state = openState(DIR, window);
  }
  if (state.complete) return;
  const done = new Set((state.done as string[] | undefined) ?? []);
  const snapshot = local;
  state.snapshot = snapshot;
  saveState(DIR, state);
  console.log(`chat: export ${snapshot}`);
  const zips = fs
    .readdirSync(local)
    .map((f) => path.join(local, f))
    .filter((line) => line.endsWith('.zip') && ZIP_PREFIXES.some((prefix) => baseName(line).startsWith(prefix)))
    .sort((a, b) => {
      const rank = (url: string) => (baseName(url).startsWith('light_metadata-') ? 0 : 1);
      return rank(a) - rank(b) || a.localeCompare(b);
    });

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rts-chat-'));
  const cleanup = () => fs.rmSync(tmp, { recursive: true, force: true });
  const interrupted = () => process.exit(130);
  process.on('exit', cleanup);
  process.on('SIGINT', interrupted);
  process.on('SIGTERM', interrupted);
  try {
    let userPages = pagesIn(USERS_DIR).length;
    for (const url of zips) {
      const name = baseName(url);
      if (done.has(name)) continue;
      const pageDir = path.join(CONVERSATIONS_DIR, name);
      fs.rmSync(pageDir, { recursive: true, force: true });
      const zip = path.join(tmp, 'export.zip');
      fs.copyFileSync(url, zip);
      const members = execFileSync('unzip', ['-Z1', zip], { encoding: 'utf8', maxBuffer: 1 << 28 })
        .split('\n')
        .filter(Boolean);
      const named = (base: string) => members.filter((m) => m.slice(m.lastIndexOf('/') + 1) === base);

      const users: User[] = [];
      for (const member of named('users.json')) {
        for await (const user of zipMember(zip, member)) {
          if (user?.uuid) users.push({ uuid: user.uuid, email: (user.email_address ?? '').trim().toLowerCase() });
        }
      }
      if (users.length) savePage(USERS_DIR, ++userPages, users);

      let page: Conversation[] = [];
      let pages = 0;
      let seen = 0;
      let kept = 0;
      const flush = () => {
        if (!page.length) return;
        savePage(pageDir, ++pages, page);
        page = [];
      };
      for (const member of named('conversations.json')) {
        for await (const conversation of zipMember(zip, member)) {
          seen++;
          const stripped = strip(conversation, window);
          if (!stripped) continue;
          kept++;
          page.push(stripped);
          if (page.length === PAGE) flush();
        }
      }
      flush();
      fs.rmSync(zip, { force: true });
      done.add(name);
      state.done = [...done];
      saveState(DIR, state);
      console.log(`chat ${name}: ${users.length} accounts · ${seen} conversations read · ${kept} with messages in the window`);
    }
  } finally {
    cleanup();
    process.off('exit', cleanup);
    process.off('SIGINT', interrupted);
    process.off('SIGTERM', interrupted);
  }
  state.complete = true;
  saveState(DIR, state);
}

export async function collectChat(window: Window): Promise<Collected & { snapshot: string }> {
  await pull(window);
  const snapshot = String(openState(DIR, window).snapshot ?? '');
  const emailOf = new Map<string, string>();
  for (const file of pagesIn(USERS_DIR)) {
    for (const user of readPage<User[]>(file)) if (user.email) emailOf.set(user.uuid, user.email);
  }
  const zipDirs = fs.existsSync(CONVERSATIONS_DIR) ? fs.readdirSync(CONVERSATIONS_DIR).sort() : [];
  const sessions: SourceSession[] = [];
  const emails = new Set<string>();
  const seen = new Set<string>();
  const uses: SkillUse[] = [];
  let noEmail = 0;
  let newest = 0;
  for (const dir of zipDirs) {
    for (const file of pagesIn(path.join(CONVERSATIONS_DIR, dir))) {
      for (const conversation of readPage<Conversation[]>(file)) {
        if (seen.has(conversation.id)) continue;
        seen.add(conversation.id);
        const email = emailOf.get(conversation.account);
        if (!email) {
          noEmail++;
          continue;
        }
        emails.add(email);
        const times = conversation.messages.map(([t]) => t);
        const chars = conversation.messages.reduce((sum, [, count]) => sum + count, 0);
        newest = Math.max(newest, ...times);
        for (const use of conversation.skills ?? []) uses.push({ t: use.t, email, session: `chat:${conversation.id}`, skill: use.skill });
        sessions.push(
          toSession(
            `chat:${conversation.id}`,
            `sessions:email:${email}`,
            'chat',
            clampTimes(times, conversation.before, conversation.after, window),
            Math.round(chars / CHARS_PER_TOKEN),
          ),
        );
      }
    }
  }
  if (noEmail) console.log(`chat: ${noEmail} conversations belong to accounts with no email and were left out`);
  console.log(
    `chat: export dated ${snapshot}${newest ? `, newest message in the window ${iso(newest)}` : ''}. Days after the export have no chat sessions.`,
  );
  return { sessions, actors: [...emails].map(emailActor), snapshot, uses };
}
