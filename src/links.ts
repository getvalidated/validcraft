const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SHEET_ROW = /^sheet:([\w-]+):(\d+)$/;

declare const __RTS__: Partial<Sites> | undefined;

export interface Sites {
  linear: string | null;
  github: string | null;
  slack: string | null;
  lead: string | null;
}

export const sites: Sites = { linear: null, github: null, slack: null, lead: null, ...(typeof __RTS__ === 'undefined' ? {} : __RTS__) };

export const sheetUrl = (sheet: string, row: number | string) => `https://docs.google.com/spreadsheets/d/${sheet}/edit#range=${row}:${row}`;

export function urlOf(key: string, urls: Map<string, string>): string | undefined {
  const known = urls.get(key);
  if (known) return known;
  const type = key.slice(0, key.indexOf(':'));
  const rest = key.slice(type.length + 1);
  switch (type) {
    case 'ticket':
      return sites.linear ? `https://linear.app/${sites.linear}/issue/${rest}` : undefined;
    case 'page':
      return `https://www.notion.so/${rest.replace(/-/g, '')}`;
    case 'video':
    case 'image': {
      if (rest.startsWith('drive:')) return `https://drive.google.com/file/d/${rest.slice(6)}/view`;
      if (rest.startsWith('frameio:')) {
        const id = rest.slice(8);
        if (UUID.test(id)) return undefined;
        return id.includes('/') ? `https://next.frame.io/${id}` : `https://f.io/${id}`;
      }
      return /^[\w-]+(\.[\w-]+)+\//.test(rest) ? `https://${rest}` : undefined;
    }
    case 'row': {
      const m = SHEET_ROW.exec(rest);
      return m ? sheetUrl(m[1], m[2]) : undefined;
    }
    case 'pr': {
      const m = /^([^#]+)#(\d+)$/.exec(rest);
      return m && sites.github ? `https://github.com/${sites.github}/${m[1]}/pull/${m[2]}` : undefined;
    }
    case 'thread': {
      const m = /^([A-Z0-9]+):(\d+)\.(\d+)$/.exec(rest);
      return m && sites.slack ? `https://${sites.slack}.slack.com/archives/${m[1]}/p${m[2]}${m[3]}` : undefined;
    }
    case 'creative':
    case 'winning_ad':
    case 'client_winner':
      return urls.get(`ad:${rest.slice(rest.indexOf(':') + 1)}`);
    default:
      return undefined;
  }
}
