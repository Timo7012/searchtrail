import { build } from 'esbuild';
import { readdir, mkdir, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';

await rm('.test-build', { recursive: true, force: true });
await mkdir('.test-build', { recursive: true });
const entries = (await readdir('tests')).filter(name => name.endsWith('.test.ts'));
for (const name of entries) {
  await build({ entryPoints: [`tests/${name}`], outfile: `.test-build/${name.replace(/\.ts$/, '.cjs')}`, bundle: true, platform: 'node', format: 'cjs', target: 'node20', alias: { obsidian: './tests/obsidian-mock.ts' } });
}
const output = entries.map(name => `.test-build/${name.replace(/\.ts$/, '.cjs')}`);
const result = spawnSync(process.execPath, ['--test', ...output], { stdio: 'inherit' });
process.exitCode = result.status ?? 1;
