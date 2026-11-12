#!/usr/bin/env node
/** Explicit local development installation. Never discovers vaults or enables plugins. */
import { lstat, mkdir, open, readFile, realpath, rename, stat, unlink } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';

const FILES = ['main.js', 'manifest.json', 'styles.css'];
const DEFAULT_SOURCE = fileURLToPath(new URL('../', import.meta.url));

function within(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
}

function overlaps(a, b) { return within(a, b) || within(b, a); }
function sameFile(a, b) { return a.dev === b.dev && a.ino === b.ino; }

async function maybeLstat(file) {
  try { return await lstat(file); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

function configSegments(value) {
  if (typeof value !== 'string' || !value.trim() || value !== value.trim()) {
    throw new Error('--config-dir: укажите относительное имя каталога без пробелов по краям.');
  }
  if (path.isAbsolute(value) || path.win32.isAbsolute(value) || /^[a-zA-Z]:/.test(value)) {
    throw new Error('--config-dir должен быть относительным путём внутри выбранного vault.');
  }
  const segments = value.replaceAll('\\', '/').split('/');
  if (segments.some(segment => !segment || segment === '.' || segment === '..'
    || /[<>:"|?*\x00-\x1f]/.test(segment) || /[. ]$/.test(segment)
    || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(segment))) {
    throw new Error('--config-dir содержит недопустимое имя или переход между каталогами.');
  }
  return segments;
}

async function canonicalDirectory(value, label) {
  if (typeof value !== 'string' || !path.isAbsolute(value)) throw new Error(`${label}: требуется абсолютный путь.`);
  let canonical;
  try { canonical = await realpath(value); }
  catch (error) { throw new Error(`${label}: каталог не найден: ${value}`, { cause: error }); }
  const info = await stat(canonical);
  if (!info.isDirectory()) throw new Error(`${label}: путь не является каталогом: ${value}`);
  return { path: canonical, info };
}

async function loadSources(sourceDir) {
  const source = await canonicalDirectory(sourceDir, 'Исходники');
  const payloads = [];
  for (const name of FILES) {
    const sourcePath = path.join(source.path, name);
    const info = await maybeLstat(sourcePath);
    if (!info || !info.isFile() || info.isSymbolicLink()) {
      throw new Error(`Нет обычного файла сборки ${sourcePath}. Выполните npm run build перед установкой.`);
    }
    const canonical = await realpath(sourcePath);
    if (!within(source.path, canonical)) throw new Error(`Файл сборки выходит за пределы исходников: ${sourcePath}`);
    payloads.push({ name, source: sourcePath, bytes: await readFile(sourcePath) });
  }
  if (!payloads[0].bytes.toString('utf8').trim()) throw new Error('main.js пуст. Выполните npm run build перед установкой.');
  let manifest;
  try { manifest = JSON.parse(payloads[1].bytes.toString('utf8').replace(/^\uFEFF/, '')); }
  catch (error) { throw new Error('manifest.json содержит некорректный JSON.', { cause: error }); }
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)
    || typeof manifest.id !== 'string' || !/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(manifest.id)) {
    throw new Error('manifest.json: id должен состоять из строчных латинских букв, цифр и одиночных дефисов, начинаться с буквы.');
  }
  return { source, payloads, pluginId: manifest.id };
}

async function inspectDirectories(vault, segments, requiredCount, source, destination) {
  if (!within(vault, destination) || overlaps(source.path, destination)) {
    throw new Error('Каталог установки должен находиться внутри vault и не пересекаться с каталогом исходников.');
  }
  let current = vault;
  for (const [index, segment] of segments.entries()) {
    current = path.join(current, segment);
    const info = await maybeLstat(current);
    if (!info) {
      if (index < requiredCount) throw new Error(`Каталог конфигурации не существует: ${current}. Сначала откройте тестовый vault в Obsidian.`);
      continue;
    }
    if (info.isSymbolicLink()) throw new Error(`Символические ссылки в пути установки не поддерживаются: ${current}`);
    if (!info.isDirectory()) throw new Error(`Ожидался каталог, но найден другой объект: ${current}`);
    const canonical = await realpath(current);
    if (!within(vault, canonical)) throw new Error(`Путь установки выходит за пределы выбранного vault: ${current}`);
    if (index === segments.length - 1 && (overlaps(source.path, canonical) || sameFile(source.info, info))) {
      throw new Error('Каталог установки совпадает или пересекается с каталогом исходников.');
    }
  }
}

async function inspectDestinationFiles(destination) {
  for (const name of FILES) {
    const target = path.join(destination, name);
    const info = await maybeLstat(target);
    if (info && (info.isSymbolicLink() || !info.isFile())) {
      throw new Error(`Файл назначения не является обычным файлом; он не изменён: ${target}`);
    }
  }
}

async function ensureDestination(vault, segments, requiredCount, source, destination) {
  let current = vault;
  for (const [index, segment] of segments.entries()) {
    current = path.join(current, segment);
    if (index < requiredCount) continue; // Existing vault config is never created by this tool.
    await inspectDirectories(vault, segments, requiredCount, source, destination);
    const info = await maybeLstat(current);
    if (!info) {
      try { await mkdir(current); }
      catch (error) { if (error.code !== 'EEXIST') throw error; }
    }
  }
  await inspectDirectories(vault, segments, requiredCount, source, destination);
}

async function atomicWrite(destination, bytes, verifyParents) {
  await verifyParents();
  const temp = path.join(path.dirname(destination), `.${path.basename(destination)}.install-${process.pid}-${randomUUID()}.tmp`);
  const handle = await open(temp, 'wx', 0o644);
  const identity = await handle.stat();
  let closed = false;
  let renamed = false;
  try {
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.close();
    closed = true;
    await verifyParents();
    const targetInfo = await maybeLstat(destination);
    if (targetInfo && (targetInfo.isSymbolicLink() || !targetInfo.isFile())) throw new Error(`Изменился тип файла назначения: ${destination}`);
    await rename(temp, destination);
    renamed = true;
  } finally {
    if (!closed) await handle.close().catch(() => {});
    if (!renamed) {
      // Only our own regular temporary file may be removed. Never unlink a symlink.
      const current = await maybeLstat(temp);
      if (current?.isFile() && !current.isSymbolicLink() && sameFile(identity, current)) await unlink(temp);
    }
  }
}

/** Copies exactly the three build artifacts. Existing plugin state and other files are untouched. */
export async function installToVault({ sourceDir = DEFAULT_SOURCE, vault, configDir = '.obsidian', dryRun = false, log = console.log } = {}) {
  const config = configSegments(configDir);
  // All source bytes and manifest validation precede ANY directory creation or writes.
  const { source, payloads, pluginId } = await loadSources(sourceDir);
  const canonicalVault = await canonicalDirectory(vault, 'Vault');
  const segments = [...config, 'plugins', pluginId];
  const destination = path.join(canonicalVault.path, ...segments);
  const verify = () => inspectDirectories(canonicalVault.path, segments, config.length, source, destination);
  await verify();
  await inspectDestinationFiles(destination);
  const plan = payloads.map(payload => ({ source: payload.source, destination: path.join(destination, payload.name) }));
  log(`${dryRun ? 'Проверка без записи' : 'Установка'}: ${pluginId}`);
  for (const item of plan) log(`  ${item.source} -> ${item.destination}`);
  if (dryRun) {
    log('Dry run завершён. Файлы и каталоги не создавались и не изменялись.');
    return { pluginId, vault: canonicalVault.path, directory: destination, files: plan, copied: [], dryRun: true };
  }
  await ensureDestination(canonicalVault.path, segments, config.length, source, destination);
  const copied = [];
  try {
    for (const payload of payloads) {
      const target = path.join(destination, payload.name);
      await atomicWrite(target, payload.bytes, verify);
      copied.push(target);
    }
  } catch (error) {
    throw new Error(`Установка прервана после обновления ${copied.length} из ${FILES.length} файлов. Уже обновлённые файлы не откатывались. ${error.message}`, { cause: error });
  }
  log('Скопированы main.js, manifest.json и styles.css. Каждый файл заменён отдельно; операция не является общей транзакцией.');
  log('Откройте тестовый vault в Obsidian. Если плагин включён, выключите и снова включите его для загрузки новой сборки.');
  return { pluginId, vault: canonicalVault.path, directory: destination, files: plan, copied, dryRun: false };
}

const HELP = `Установить локальную сборку SearchTrail в явно выбранный тестовый vault.

Использование:
  node scripts/install-dev.mjs --vault '/absolute/path/to/Test Vault' [--config-dir .obsidian] [--dry-run]

Параметры:
  --vault PATH       Абсолютный путь к существующему vault (обязательно).
  --config-dir PATH  Относительный каталог конфигурации внутри vault; по умолчанию .obsidian.
                     Каталог должен уже существовать после открытия vault в Obsidian.
  --dry-run          Проверить пути и показать три назначения без записи файлов.
  --help, -h         Показать справку.

Сначала выполните npm run build. Копируются только main.js, manifest.json и styles.css.
data.json, прочие файлы плагина и community-plugins.json сохраняются.
Плагин не включается автоматически; Obsidian не запускается.
Символические ссылки внутри пути назначения и пересечение с исходниками запрещены.
`;

export function parseArguments(args) {
  const result = { dryRun: false, configDir: '.obsidian', vault: undefined, help: false };
  const seen = new Set();
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--help' || argument === '-h') { result.help = true; continue; }
    if (!['--vault', '--config-dir', '--dry-run'].includes(argument)) throw new Error(`Неизвестный параметр: ${argument}. Используйте --help.`);
    if (seen.has(argument)) throw new Error(`Параметр указан дважды: ${argument}`);
    seen.add(argument);
    if (argument === '--dry-run') { result.dryRun = true; continue; }
    const value = args[++index];
    if (value === undefined || value.startsWith('--')) throw new Error(`Не указано значение ${argument}.`);
    result[argument === '--vault' ? 'vault' : 'configDir'] = value;
  }
  if (!result.help && !result.vault) throw new Error('Укажите --vault с абсолютным путём к тестовому vault. Используйте --help.');
  return result;
}

async function main() {
  try {
    const options = parseArguments(process.argv.slice(2));
    if (options.help) console.log(HELP);
    else await installToVault(options);
  } catch (error) {
    console.error(`Ошибка: ${error.message}`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) await main();
