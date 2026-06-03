/**
 * node-pty ships prebuilt binaries, but on some setups npm extraction drops the
 * execute bit on the unix `spawn-helper`, causing `posix_spawnp failed` at
 * spawn time. This restores it. No-op on Windows (conpty needs no helper).
 */
import { chmodSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

if (process.platform === 'win32') {
  process.exit(0);
}

const prebuilds = join(
  process.cwd(),
  'node_modules',
  'node-pty',
  'prebuilds',
);

if (!existsSync(prebuilds)) {
  process.exit(0);
}

let fixed = 0;
for (const dir of readdirSync(prebuilds)) {
  const helper = join(prebuilds, dir, 'spawn-helper');
  if (existsSync(helper) && statSync(helper).isFile()) {
    chmodSync(helper, 0o755);
    fixed++;
  }
}

if (fixed > 0) {
  console.log(`[fix-pty-perms] made ${fixed} spawn-helper binary(ies) executable`);
}
