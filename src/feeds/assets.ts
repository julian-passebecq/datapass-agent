import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { safeLocalSource } from '../cockpit/configuration';
import { digest } from '../cockpit/policy';
import type { AssetRef } from '../cockpit/facade';
export interface LocalAsset extends AssetRef { file: string; name: string; }
/** Only explicitly selected roots; no links, recursive history crawl, or inference of generation. */
export async function scanAssets(roots: string[]): Promise<LocalAsset[]> {
  const assets: LocalAsset[] = [];
  for (const root of roots.slice(0, 20)) {
    if (!path.isAbsolute(root)) continue;
    const names = await fs.readdir(root, { withFileTypes: true }).catch(() => []);
    for (const entry of names.slice(0, 500)) {
      if (!entry.isFile() || !/\.(png|jpe?g|gif|webp)$/i.test(entry.name)) continue;
      const file = path.join(root, entry.name);
      if (!await safeLocalSource(file)) continue;
      const st = await fs.stat(file); if (st.size > 10 * 1024 * 1024) continue;
      const sha256 = createHash('sha256').update(await fs.readFile(file)).digest('hex');
      assets.push({ id: 'asset:' + digest(file).slice(0, 24), sourceId: 'asset-root:' + digest(root).slice(0, 24), file, name: entry.name, sha256, bytes: st.size, state: 'FILE_OBSERVED', producer: null });
      if (assets.length === 200) return assets;
    }
  }
  return assets;
}
