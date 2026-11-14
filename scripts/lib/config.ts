import fs from 'node:fs';
import path from 'node:path';

export interface ClientConfig {
  id: string;
  name: string;
  shortname?: string | null;
  since?: string | null;
  slackChannel?: string | null;
  metaAccounts?: string[];
  tiktokAdvertisers?: string[];
}

export interface Config {
  org: { name: string; domains: string[]; lead: string | null };
  clients: ClientConfig[];
  bucket: string | null;
  slack: { workspace: string | null; channelPrefixes: string[] };
  linear: { workspace: string | null; engTeam: string | null; conceptTeam: string | null; conceptLabels: string[]; parkedStates: string[] };
  github: { org: string | null; focusAuthor: string | null };
  notion: Record<string, never>;
  calendar: { domain: string | null };
  sentry: { api: string; org: string | null; project: string | null };
  meta: { ownAdName: string | null };
  tiktok: { ownAdName: string | null };
  spend: { gcpProject: string | null; gcpBillingTable: string | null };
  ops: Record<string, never>;
  workspace: { domain: string | null; admin: string | null };
  sessions: { gcpProject: string | null };
}

export const CONFIG_FILE = path.resolve('rts.config.json');

const DEFAULTS: Config = {
  org: { name: 'Home', domains: [], lead: null },
  clients: [],
  bucket: null,
  slack: { workspace: null, channelPrefixes: [] },
  linear: { workspace: null, engTeam: null, conceptTeam: null, conceptLabels: [], parkedStates: [] },
  github: { org: null, focusAuthor: null },
  notion: {},
  calendar: { domain: null },
  sentry: { api: 'https://sentry.io/api/0', org: null, project: null },
  meta: { ownAdName: null },
  tiktok: { ownAdName: null },
  spend: { gcpProject: null, gcpBillingTable: null },
  ops: {},
  workspace: { domain: null, admin: null },
  sessions: { gcpProject: null },
};

try {
  process.loadEnvFile();
} catch {}

const saved: Partial<Config> = fs.existsSync(CONFIG_FILE) ? JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')) : {};

export const config = Object.fromEntries(
  Object.entries(DEFAULTS).map(([key, value]) => {
    const given = (saved as Record<string, unknown>)[key];
    if (given === undefined) return [key, value];
    return [key, value && typeof value === 'object' && !Array.isArray(value) ? { ...value, ...(given as object) } : given];
  }),
) as unknown as Config;

export function secret(name: string) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is not set. Put it in .env or the environment.`);
  return value;
}

export function setting<T>(value: T | null | undefined, name: string): T {
  if (value === null || value === undefined || value === '') throw new Error(`${name} is not set in rts.config.json.`);
  return value;
}
