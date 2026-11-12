import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, lstat, symlink, rm, realpath } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { installToVault, parseArguments } from './install-dev.mjs';

const ARTIFACTS = {
  'main.js': 'module.exports = class ResearchSearch {};\n',
  'manifest.json': JSON.stringify({ id: 'research-search', name: 'SearchTrail', version: '0.1.1' }, null, 2),
  'styles.css': '.research-search { color: inherit; }\n',
};
const quiet = () => {};

async function exists(file) {
  try { await lstat(file); return true; }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

async function buildFiles(directory, changes = {}) {
  await mkdir(directory, { recursive: true });
  for (const [name, content] of Object.entries({ ...ARTIFACTS, ...changes })) {
    if (content !== null) await writeFile(path.join(directory, name), content);
  }
}

async function fixture(t, { configDir = '.obsidian', artifacts = ARTIFACTS } = {}) {
  const originalRoot = await mkdtemp(path.join(os.tmpdir(), 'research-search-install-test-'));
  // macOS may expose the same temp directory through /var and /private/var.
  const root = await realpath(originalRoot);
  // Test cleanup is limited to this newly-created synthetic fixture, never a supplied vault.
  t.after(async () => {
    assert.ok(path.basename(originalRoot).startsWith('research-search-install-test-'));
    assert.equal(path.dirname(originalRoot), path.resolve(os.tmpdir()));
    await rm(originalRoot, { recursive: true, force: true });
  });
  const source = path.join(root, 'source');
  const vault = path.join(root, 'Test Vault');
  const config = path.join(vault, configDir);
  await mkdir(source);
  await mkdir(config, { recursive: true });
  for (const [name, bytes] of Object.entries(artifacts)) await writeFile(path.join(source, name), bytes);
  return { root, source, vault, config, plugin: path.join(config, 'plugins', 'research-search') };
}

test('copies only the three artifacts and preserves data.json, notes and plugin enablement', async t => {
  const f = await fixture(t);
  await mkdir(f.plugin, { recursive: true });
  await writeFile(path.join(f.plugin, 'data.json'), '{"user":"keep"}');
  await writeFile(path.join(f.plugin, 'notes.md'), '# Keep these notes\n');
  await writeFile(path.join(f.config, 'community-plugins.json'), '["another-plugin"]');
  await writeFile(path.join(f.source, 'unrelated.txt'), 'Do not copy');
  const result = await installToVault({ sourceDir: f.source, vault: f.vault, log: quiet });
  assert.equal(result.copied.length, 3);
  assert.equal(result.pluginId, 'research-search');
  for (const [name, bytes] of Object.entries(ARTIFACTS)) assert.equal(await readFile(path.join(f.plugin, name), 'utf8'), bytes);
  assert.equal(await readFile(path.join(f.plugin, 'data.json'), 'utf8'), '{"user":"keep"}');
  assert.equal(await readFile(path.join(f.plugin, 'notes.md'), 'utf8'), '# Keep these notes\n');
  assert.equal(await readFile(path.join(f.config, 'community-plugins.json'), 'utf8'), '["another-plugin"]');
  assert.deepEqual((await readdir(f.plugin)).sort(), ['data.json', 'main.js', 'manifest.json', 'notes.md', 'styles.css']);
  await writeFile(path.join(f.source, 'main.js'), '// updated build\nmodule.exports = {};\n');
  await installToVault({ sourceDir: f.source, vault: f.vault, log: quiet });
  assert.equal(await readFile(path.join(f.plugin, 'main.js'), 'utf8'), '// updated build\nmodule.exports = {};\n');
  assert.equal(await readFile(path.join(f.plugin, 'data.json'), 'utf8'), '{"user":"keep"}');
});

test('dry run prints the three proposed paths and makes no directories or files', async t => {
  const f = await fixture(t);
  const messages = [];
  const result = await installToVault({ sourceDir: f.source, vault: f.vault, dryRun: true, log: message => messages.push(message) });
  assert.equal(result.dryRun, true);
  assert.deepEqual(result.copied, []);
  assert.equal(await exists(path.join(f.config, 'plugins')), false);
  assert.deepEqual(await readdir(f.config), []);
  for (const name of Object.keys(ARTIFACTS)) assert.ok(messages.some(line => line.includes(path.join(f.plugin, name))));
});

test('all build artifacts must exist before creating plugin directories', async t => {
  const f = await fixture(t, { artifacts: { 'main.js': ARTIFACTS['main.js'], 'manifest.json': ARTIFACTS['manifest.json'] } });
  await assert.rejects(installToVault({ sourceDir: f.source, vault: f.vault, log: quiet }), /styles\.css/);
  assert.equal(await exists(path.join(f.config, 'plugins')), false);
});

test('unsafe or malformed manifest IDs are rejected without creating directories', async t => {
  const f = await fixture(t);
  for (const id of ['../other-plugin', '/tmp/plugin', 'Name', 'two--hyphens', '', null]) {
    await writeFile(path.join(f.source, 'manifest.json'), JSON.stringify({ id }));
    await assert.rejects(installToVault({ sourceDir: f.source, vault: f.vault, log: quiet }), /manifest\.json/);
  }
  await writeFile(path.join(f.source, 'manifest.json'), '{not json');
  await assert.rejects(installToVault({ sourceDir: f.source, vault: f.vault, log: quiet }), /JSON/);
  assert.deepEqual(await readdir(f.config), []);
});

test('traversal, absolute config paths and missing existing config/vault are refused', async t => {
  const f = await fixture(t);
  for (const configDir of ['../other', 'nested/../../other', '/absolute', 'C:\\outside', '.obsidian/../outside', '.obsidian//nested', '.', '']) {
    await assert.rejects(installToVault({ sourceDir: f.source, vault: f.vault, configDir, log: quiet }));
  }
  await assert.rejects(installToVault({ sourceDir: f.source, vault: f.vault, configDir: 'missing-config', log: quiet }), /конфигурации не существует/);
  await assert.rejects(installToVault({ sourceDir: f.source, vault: path.join(f.root, 'missing-vault'), log: quiet }), /каталог не найден/);
  await assert.rejects(installToVault({ sourceDir: f.source, vault: 'relative-vault', log: quiet }), /абсолютный/);
  assert.deepEqual(await readdir(f.config), []);
  assert.equal(await exists(path.join(f.vault, 'missing-config')), false);
});

test('a custom existing config directory is used literally', async t => {
  const f = await fixture(t, { configDir: 'Custom Config' });
  const result = await installToVault({ sourceDir: f.source, vault: f.vault, configDir: 'Custom Config', log: quiet });
  assert.equal(result.directory, f.plugin);
  assert.equal(await exists(path.join(f.vault, '.obsidian')), false);
  assert.equal(await readFile(path.join(f.plugin, 'main.js'), 'utf8'), ARTIFACTS['main.js']);
});

test('a repository already at the plugin destination is not installed onto itself', async t => {
  const f = await fixture(t);
  await buildFiles(f.plugin);
  const before = await readFile(path.join(f.plugin, 'main.js'));
  await assert.rejects(installToVault({ sourceDir: f.plugin, vault: f.vault, log: quiet }), /исходник/);
  assert.deepEqual(await readFile(path.join(f.plugin, 'main.js')), before);
  assert.deepEqual((await readdir(f.plugin)).sort(), Object.keys(ARTIFACTS).sort());
});

test('an invalid destination artifact prevents any of the three files from being updated', async t => {
  const f = await fixture(t);
  await mkdir(path.join(f.plugin, 'styles.css'), { recursive: true });
  await writeFile(path.join(f.plugin, 'main.js'), 'existing main');
  await writeFile(path.join(f.plugin, 'manifest.json'), 'existing manifest');
  await assert.rejects(installToVault({ sourceDir: f.source, vault: f.vault, log: quiet }), /не является обычным/);
  assert.equal(await readFile(path.join(f.plugin, 'main.js'), 'utf8'), 'existing main');
  assert.equal(await readFile(path.join(f.plugin, 'manifest.json'), 'utf8'), 'existing manifest');
});

test('symlinked config/plugin directories and target files are refused without touching targets', { skip: process.platform === 'win32' }, async t => {
  const f = await fixture(t);
  const outside = path.join(f.root, 'outside');
  await mkdir(outside);
  await writeFile(path.join(outside, 'sentinel'), 'keep outside');
  await symlink(outside, path.join(f.vault, 'linked-config'), 'dir');
  await assert.rejects(installToVault({ sourceDir: f.source, vault: f.vault, configDir: 'linked-config', log: quiet }), /Символические ссылки/);
  assert.deepEqual(await readdir(outside), ['sentinel']);

  await symlink(outside, path.join(f.config, 'plugins'), 'dir');
  await assert.rejects(installToVault({ sourceDir: f.source, vault: f.vault, log: quiet }), /Символические ссылки/);
  assert.deepEqual(await readdir(outside), ['sentinel']);

  const second = await fixture(t, { configDir: 'Other Config' });
  await mkdir(path.join(second.config, 'plugins'));
  await symlink(outside, second.plugin, 'dir');
  await assert.rejects(installToVault({ sourceDir: second.source, vault: second.vault, configDir: 'Other Config', log: quiet }), /Символические ссылки/);
  assert.deepEqual(await readdir(outside), ['sentinel']);

  const third = await fixture(t);
  await mkdir(third.plugin, { recursive: true });
  const target = path.join(outside, 'sentinel');
  await symlink(target, path.join(third.plugin, 'main.js'), 'file');
  await assert.rejects(installToVault({ sourceDir: third.source, vault: third.vault, log: quiet }), /не является обычным/);
  assert.equal(await readFile(target, 'utf8'), 'keep outside');
  assert.equal((await lstat(path.join(third.plugin, 'main.js'))).isSymbolicLink(), true);
});

test('explicit vault aliases resolve to their canonical vault, without symlinks inside the install path', { skip: process.platform === 'win32' }, async t => {
  const f = await fixture(t);
  const alias = path.join(f.root, 'vault-alias');
  await symlink(f.vault, alias, 'dir');
  const result = await installToVault({ sourceDir: f.source, vault: alias, dryRun: true, log: quiet });
  assert.equal(result.vault, f.vault);
  assert.equal(result.directory, f.plugin);
  assert.equal(await exists(path.join(f.config, 'plugins')), false);
});

test('CLI parsing requires an explicit vault and does not infer one', () => {
  assert.throws(() => parseArguments([]), /--vault/);
  assert.throws(() => parseArguments(['--unknown']), /Неизвестный/);
  assert.throws(() => parseArguments(['--vault']), /Не указано значение/);
  assert.throws(() => parseArguments(['--vault', '/one', '--vault', '/two']), /дважды/);
  assert.equal(parseArguments(['--help']).help, true);
  assert.deepEqual(parseArguments(['--vault', '/Test Vault', '--dry-run']), { vault: '/Test Vault', dryRun: true, configDir: '.obsidian', help: false });
});
