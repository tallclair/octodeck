
export interface ParsedUrl {
  owner: string;
  repo: string;
  number: number;
}

export class UrlParser {
  static parse(url: string): ParsedUrl | null {
    try {
      const urlObj = new URL(url);
      if (urlObj.hostname !== 'github.com') {
        return null;
      }

      const parts = urlObj.pathname.split('/').filter(Boolean);
      // Expected format: /:owner/:repo/pull/:number or /:owner/:repo/issues/:number
      if (parts.length < 4) {
        return null;
      }

      const owner = parts[0];
      const repo = parts[1];
      const type = parts[2];
      const numberStr = parts[3];

      if ((type === 'pull' || type === 'issues') && /^\d+$/.test(numberStr)) {
        return {
          owner,
          repo,
          number: parseInt(numberStr, 10),
        };
      }

      return null;
    } catch {
      return null;
    }
  }
}
