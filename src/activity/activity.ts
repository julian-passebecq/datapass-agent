import { AgentSessionSnapshot, Provider } from '../model';

export interface DayActivity {
  day: string; // YYYY-MM-DD local
  label: string; // Mon, Tue…
  sessions: number;
  workers: number;
  durationMin: number; // observed (first→last activity), clipped to the day
  commits: number;
  filesChanged: number;
  tests: number;
  repos: string[];
  byProvider: Record<Provider, number>;
}

function dayKey(t: number): string {
  const d = new Date(t);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** Factual per-day rollup. No productivity score. */
export function weekly(sessions: AgentSessionSnapshot[], now: number, days = 7): DayActivity[] {
  const out: DayActivity[] = [];
  const names = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(now);
    d.setHours(0, 0, 0, 0);
    d.setDate(d.getDate() - i);
    out.push({ day: dayKey(d.getTime()), label: names[d.getDay()], sessions: 0, workers: 0, durationMin: 0, commits: 0, filesChanged: 0, tests: 0, repos: [], byProvider: { claude: 0, codex: 0 } });
  }
  const idx = new Map(out.map((d, i) => [d.day, i]));
  for (const s of sessions) {
    if (!s.startedAt || !s.lastActivityAt) continue;
    const start = new Date(s.startedAt);
    start.setHours(0, 0, 0, 0);
    for (let t = start.getTime(); t <= s.lastActivityAt; t += 86400_000) {
      const i = idx.get(dayKey(t));
      if (i === undefined) continue;
      const d = out[i];
      const from = Math.max(s.startedAt, t), to = Math.min(s.lastActivityAt, t + 86400_000);
      if (s.isWorker) d.workers++;
      else {
        d.sessions++;
        d.byProvider[s.provider]++;
      }
      d.durationMin += Math.max(0, Math.round((to - from) / 60_000));
      d.commits += s.commits.filter(c => dayKey(c.at) === d.day).length;
      d.tests += s.tests.filter(x => dayKey(x.at) === d.day).length;
      if (dayKey(s.lastActivityAt) === d.day) d.filesChanged += s.changedFiles.length;
      const repo = s.repository ?? s.cwd;
      if (repo) {
        const name = repo.split(/[\\/]/).filter(Boolean).pop() ?? repo;
        if (!d.repos.includes(name)) d.repos.push(name);
      }
    }
  }
  return out;
}

export interface CockpitSummary {
  active: number;
  idle: number;
  needsInput: number;
  endedToday: number;
  unknown: number;
}

export function summarize(sessions: AgentSessionSnapshot[], now: number): CockpitSummary {
  const today = dayKey(now);
  const top = sessions.filter(s => !s.isWorker);
  return {
    active: top.filter(s => s.status === 'RUNNING').length,
    idle: top.filter(s => s.status === 'IDLE').length,
    needsInput: top.filter(s => s.status === 'NEEDS_INPUT').length,
    endedToday: top.filter(s => s.status === 'ENDED' && s.endedAt && dayKey(s.endedAt) === today).length,
    unknown: top.filter(s => s.status === 'UNKNOWN').length,
  };
}

export function duration(ms: number | undefined): string {
  if (ms === undefined || ms < 0) return '—';
  const m = Math.round(ms / 60_000);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return h < 24 ? `${h}h${String(m % 60).padStart(2, '0')}` : `${Math.floor(h / 24)}d${h % 24}h`;
}
