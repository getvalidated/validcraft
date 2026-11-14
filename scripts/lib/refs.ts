import type { ResourceType } from '../../src/schema';

export interface Ref {
  resource: ResourceType;
  id: string;
  building: string | null;
  feature: string | null;
  known?: boolean;
}

export const refKey = (resource: ResourceType, id: string) => `${resource}:${id}`;

const URL = /https?:\/\/[^\s<>|)\]"']+/g;
const VIDEO_FILE = /\.(mp4|mov|m4v|webm)$/i;
const REPORT_FILE = /\.html?$/i;
const DRIVE = /(?:drive|docs)\.google\.com\/(?:file\/d\/|open\?id=|uc\?(?:[\w=&]*&)?id=)([\w-]{20,})/;

const SITES: { test: RegExp; ref: (m: RegExpExecArray) => Ref }[] = [
  { test: /linear\.app\/[^/]+\/issue\/([A-Za-z][A-Za-z0-9]*-\d+)/, ref: (m) => ({ resource: 'ticket', id: m[1].toUpperCase(), building: 'linear', feature: null }) },
  {
    test: /slack\.com\/archives\/([A-Z0-9]+)\/p(\d{10})(\d{6})(?:\?(?:[^#]*&)?thread_ts=(\d+\.\d+))?/,
    ref: (m) => ({ resource: 'thread', id: `${m[1]}:${m[4] ?? `${m[2]}.${m[3]}`}`, building: 'slack', feature: null }),
  },
  { test: /github\.com\/[^/]+\/([^/]+)\/pull\/(\d+)/, ref: (m) => ({ resource: 'pr', id: `${m[1]}#${m[2]}`, building: 'github', feature: null }) },
  {
    test: /notion\.(?:so|site|com)\/(?:[^\s?#]*[-/])?([0-9a-f]{8})([0-9a-f]{4})([0-9a-f]{4})([0-9a-f]{4})([0-9a-f]{12})(?:[?#]|$)/,
    ref: (m) => ({ resource: 'page', id: m.slice(1, 6).join('-'), building: 'notion', feature: null }),
  },
  {
    test: /frame\.io\/(?:project|share)\/[\w-]+\/view\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/,
    ref: (m) => ({ resource: 'video', id: `frameio:${m[1]}`, building: 'frameio', feature: null, known: true }),
  },
  {
    test: /claude\.(?:ai|site)\/(?:public\/|code\/)?artifacts?\/([\w-]+)/,
    ref: (m) => ({ resource: 'report', id: `claude:${m[1]}`, building: 'reports', feature: 'Claude artifacts' }),
  },
  { test: /(?:frame\.io|\/\/f\.io)\/([^\s?#]+)/, ref: (m) => ({ resource: 'video', id: `frameio:${m[1]}`, building: 'frameio', feature: null, known: true }) },
  { test: /higgsfield\.ai\/([^\s?#]*\d[^\s?#]{7,})/, ref: (m) => ({ resource: 'video', id: `higgsfield:${m[1]}`, building: 'video-tools', feature: 'Higgsfield' }) },
  { test: /kling(?:ai)?\.com\/([^\s?#]*\d[^\s?#]{7,})/, ref: (m) => ({ resource: 'video', id: `kling:${m[1]}`, building: 'video-tools', feature: 'Kling' }) },
];

export function refOf(link: string, name = ''): Ref | { drive: string } | null {
  for (const site of SITES) {
    const m = site.test.exec(link);
    if (m) return site.ref(m);
  }
  const drive = DRIVE.exec(link);
  if (drive) return { drive: drive[1] };
  const path = link.replace(/^https?:\/\//, '').replace(/[?#].*$/, '');
  if (VIDEO_FILE.test(path) || VIDEO_FILE.test(name)) return { resource: 'video', id: path, building: null, feature: null };
  if (REPORT_FILE.test(path) || REPORT_FILE.test(name)) return { resource: 'report', id: path, building: null, feature: null };
  return null;
}

export function linkName(link: string) {
  const slug = /notion\.(?:so|site|com)\/(?:[^\s/?#]+\/)*([^\s/?#]+?)-?[0-9a-f]{32}(?:[?#]|$)/.exec(link)?.[1];
  return slug ? slug.replace(/-+/g, ' ').trim() : '';
}

export const linksIn =(text: string) => [...new Set(text.match(URL) ?? [])].map((link) => link.replace(/[.,;:!?]+$/, ''));

export function markdownLinks(text: string) {
  const named = new Map<string, string>();
  for (const m of text.matchAll(/\[([^\]]*)\]\((https?:\/\/[^\s)]+)\)/g)) named.set(m[2], m[1]);
  for (const link of linksIn(text)) if (!named.has(link)) named.set(link, '');
  return [...named].map(([link, name]) => ({ link, name }));
}
