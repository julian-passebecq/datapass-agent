// Projection of the Settings and Catalog feeds into the proposed galaxy.agent-config-snapshot/1.
// Pure: no fs, no exec. Exports names, counts and safe scalar modes only. Never exported: env values or env names,
// hook commands, MCP args / URLs / headers, permission rule text, settings values, file paths (folder name + hash
// only), instruction-file content or headings. A content hash lets Galaxy tell "unchanged" from "changed".
import type { CatalogReport, CliInfo } from '../feeds/catalog';
import { effective, LayerKind, layersFor, mergedRules, SettingsReport } from '../feeds/settings';
import { EvidenceKind } from '../model';
import { bounded } from '../util/redact';
import { canonicalJson, compactObj, CONFIG_SNAPSHOT_SCHEMA, iso, PathRef, pathRef, sha256 } from './index';

export interface GalaxyClaudeLayer {
  kind: LayerKind;
  /** Repository of a project / local layer. */
  root?: PathRef;
  model?: string;
  effortLevel?: string;
  defaultMode?: string;
  outputStyle?: string;
  allow: number;
  deny: number;
  ask: number;
  /** Hook events with a hook in this layer (commands are never exported). */
  hookEvents: string[];
  hooks: number;
  /** Count of env variables set (names and values are never exported). */
  env: number;
  enabledPlugins: string[];
  apiKeyHelper: boolean;
}

export interface GalaxyCodexConfig {
  scope: 'user' | 'project';
  root?: PathRef;
  model?: string;
  effort?: string;
  approval?: string;
  sandbox?: string;
  serviceTier?: string;
  profile?: string;
  profiles: string[];
  mcpServers: string[];
  features: { name: string; on: boolean }[];
  plugins: { name: string; on: boolean }[];
  trustedProjects: number;
  notify: boolean;
}

export interface GalaxyConfigContent {
  claude?: {
    layers: GalaxyClaudeLayer[];
    /** User-scope effective values (managed > user), DERIVED from the layers. */
    effective: { model?: string; effortLevel?: string; defaultMode?: string };
    /** Distinct permission rules over the user-scope layers, DERIVED. */
    rules: { allow: number; deny: number; ask: number; hooks: number };
    /** Subagent / skill / command / output-style names from the settings feed. */
    items: { kind: string; scope: 'user' | 'project'; name: string }[];
  };
  codex?: GalaxyCodexConfig[];
  catalog?: {
    items: { provider: string; kind: string; source: string; name: string; active: boolean; plugin?: string }[];
    plugins: { provider: string; id: string; version?: string; enabled?: boolean; installed: boolean }[];
    hooks: { event: string; matcher: string; type: string; program: string; source: string }[];
    mcp: { provider: string; name: string; transport: string; source: string }[];
    /** Distinct settings key names (values are never exported). */
    settingsKeys: string[];
  };
  /** CLI probes (Catalog `--version`), when that opt-out probe ran. */
  cli?: { tool: string; status: string; version?: string }[];
}

export interface GalaxyConfigSnapshot extends GalaxyConfigContent {
  schema: typeof CONFIG_SNAPSHOT_SCHEMA;
  capturedAt: string;
  /** sha256 of the canonical JSON of the content (everything except schema, capturedAt, contentHash, kinds). */
  contentHash: string;
  kinds: Record<string, EvidenceKind>;
}

export interface ConfigSnapshotInput {
  settings?: SettingsReport;
  catalog?: CatalogReport;
  cli?: CliInfo[];
  capturedAt: number;
}

const name = (s: string, max = 80) => bounded(s, max);
const uniq = (xs: string[]) => [...new Set(xs)].sort();
const byKey = <T>(xs: T[], key: (x: T) => string) => [...xs].sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0));

function claudePart(r: SettingsReport): GalaxyConfigContent['claude'] {
  const layers = r.layers.filter(l => l.exists && !l.error).map(l => compactObj<GalaxyClaudeLayer>({
    kind: l.kind,
    root: pathRef(l.root),
    model: l.model,
    effortLevel: l.effortLevel,
    defaultMode: l.defaultMode,
    outputStyle: l.outputStyle,
    allow: l.allow.length,
    deny: l.deny.length,
    ask: l.ask.length,
    hookEvents: uniq(l.hooks.map(h => name(h.event, 40))),
    hooks: l.hooks.length,
    env: l.envNames.length + l.envHidden,
    enabledPlugins: uniq(l.enabledPlugins.map(p => name(p))),
    apiKeyHelper: l.apiKeyHelper,
  }));
  const user = layersFor(r);
  return {
    layers: byKey(layers, l => `${l.kind}|${l.root?.hash ?? ''}`),
    effective: compactObj({ model: effective(user, 'model').value, effortLevel: effective(user, 'effortLevel').value, defaultMode: effective(user, 'defaultMode').value }),
    rules: mergedRules(user),
    items: byKey(r.items.map(i => ({ kind: i.kind, scope: i.scope, name: name(i.name) })), i => `${i.kind}|${i.scope}|${i.name}`),
  };
}

function codexPart(c: SettingsReport['codex'][number]): GalaxyCodexConfig {
  return compactObj<GalaxyCodexConfig>({
    scope: c.scope,
    root: pathRef(c.root),
    model: c.model,
    effort: c.effort,
    approval: c.approval,
    sandbox: c.sandbox,
    serviceTier: c.serviceTier,
    profile: c.profile,
    profiles: uniq(c.profiles.map(p => name(p.name))),
    mcpServers: uniq(c.mcpServers.map(m => name(m))),
    features: byKey(c.features.map(f => ({ name: name(f.name), on: f.on })), f => f.name),
    plugins: byKey(c.plugins.map(p => ({ name: name(p.name), on: p.on })), p => p.name),
    trustedProjects: c.trustedProjects,
    notify: c.notify,
  });
}

function catalogPart(c: CatalogReport): GalaxyConfigContent['catalog'] {
  return {
    items: byKey(c.items.map(i => compactObj({ provider: i.provider, kind: i.kind, source: i.source, name: name(i.name), active: i.active, plugin: i.plugin ? name(i.plugin) : undefined })), i => `${i.provider}|${i.kind}|${i.source}|${i.name}`),
    plugins: byKey(c.plugins.map(p => compactObj({ provider: p.provider, id: name(p.id), version: p.version ? name(p.version, 40) : undefined, enabled: p.enabled, installed: p.installed })), p => `${p.provider}|${p.id}`),
    hooks: byKey(c.hooks.map(h => ({ event: name(h.event, 40), matcher: name(h.matcher, 80), type: h.type, program: name(h.program, 60), source: h.source })), h => `${h.event}|${h.matcher}|${h.program}`),
    mcp: byKey(c.mcp.map(m => ({ provider: m.provider, name: name(m.name), transport: m.transport, source: m.source })), m => `${m.provider}|${m.name}`),
    settingsKeys: uniq(c.settings.map(s => name(s.key, 80))),
  };
}

/** Projects whatever feeds are available; a missing feed leaves its section out (UNKNOWN), never empty-as-fact. */
export function toConfigSnapshot(input: ConfigSnapshotInput): GalaxyConfigSnapshot {
  const codexConfigs = input.settings?.codex.filter(c => c.exists && !c.error);
  const content: GalaxyConfigContent = compactObj({
    claude: input.settings ? claudePart(input.settings) : undefined,
    codex: codexConfigs ? byKey(codexConfigs.map(codexPart), c => `${c.scope}|${c.root?.hash ?? ''}`) : undefined,
    catalog: input.catalog ? catalogPart(input.catalog) : undefined,
    cli: input.cli ? byKey(input.cli.map(c => compactObj({ tool: c.tool, status: c.status, version: c.version ? name(c.version, 40) : undefined })), c => c.tool) : undefined,
  });
  const kinds: Record<string, EvidenceKind> = {
    claude: input.settings ? 'OBSERVED' : 'UNKNOWN',
    'claude.effective': input.settings ? 'DERIVED' : 'UNKNOWN',
    'claude.rules': input.settings ? 'DERIVED' : 'UNKNOWN',
    codex: input.settings ? 'OBSERVED' : 'UNKNOWN',
    catalog: input.catalog ? 'OBSERVED' : 'UNKNOWN',
    cli: input.cli ? 'OBSERVED' : 'UNKNOWN',
    contentHash: 'DERIVED',
    capturedAt: 'OBSERVED',
  };
  return {
    schema: CONFIG_SNAPSHOT_SCHEMA,
    capturedAt: iso(input.capturedAt) ?? new Date(0).toISOString(),
    contentHash: sha256(canonicalJson(content)),
    kinds,
    ...content,
  };
}
