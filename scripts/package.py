"""Package the installable plugin and complete source; requires Python 3."""
from pathlib import Path
import json
import zipfile

root = Path(__file__).resolve().parents[1]
manifest = json.loads((root / "manifest.json").read_text(encoding="utf-8"))
version = manifest["version"]
destination = root / "dist" / f"searchtrail-{version}.zip"
destination.parent.mkdir(parents=True, exist_ok=True)
ignored = {"node_modules", ".git", ".test-build", ".browser-test", "dist", "__pycache__", "dev-vault", "dev-vaults", ".local"}
private_paths = ('AGENTS.md', 'CODEX_HANDOFF.md', 'CODEX_START.txt', 'VALIDATION.md', 'docs/DEVELOPMENT.md', 'docs/MATERIALS.md', 'docs/MCP.md', 'docs/ROADMAP.md')
install = ["main.js", "manifest.json", "styles.css"]
for name in install:
    if not (root / name).is_file():
        raise SystemExit(f"Missing {name}: run npm run build first.")

start = f"""SearchTrail {version} — локальный прототип

УСТАНОВКА
1. Для знакомства используйте отдельное тестовое хранилище Obsidian.
2. Скопируйте каталог plugin/research-search в <хранилище>/.obsidian/plugins/.
   Итоговый путь: <хранилище>/.obsidian/plugins/research-search/main.js
   Если каталог настроек Obsidian переименован, используйте его вместо .obsidian.
3. В Obsidian откройте Настройки → Сторонние плагины и включите SearchTrail.
4. Откройте палитру команд и выполните SearchTrail: Открыть журнал поиска.
5. Создайте проект и первый запрос либо импортируйте examples/demo-project.json
   командой SearchTrail: Импортировать проект из JSON.

ПРИМЕР: все числа в демонстрационном проекте вымышлены, реальный поиск не выполнялся.
Исходный код и инструкция:
source/searchtrail/README.md

Плагин не опубликован в каталоге сообщества. Это локальная установка прототипа.
"""

with zipfile.ZipFile(destination, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
    archive.writestr("START_HERE.txt", start)
    for name in install:
        archive.write(root / name, f"plugin/research-search/{name}")
    example = root / "examples/demo-project.json"
    if example.is_file():
        archive.write(example, "examples/demo-project.json")
    for path in sorted(root.rglob("*")):
        relative = path.relative_to(root)
        if not path.is_file() or relative.as_posix() in private_paths or any(part in ignored for part in relative.parts):
            continue
        if path.name == ".env" or (path.name.startswith(".env.") and path.name != ".env.example") or path.suffix == ".log":
            continue
        if path.suffix in {".png", ".webm", ".mp4"}:
            continue
        archive.write(path, Path("source/searchtrail") / relative)
with zipfile.ZipFile(destination) as archive:
    corrupted = archive.testzip()
    if corrupted:
        raise SystemExit(f"Corrupt archive member: {corrupted}")
print(destination)
