import { spawnSync } from 'node:child_process';

const python = process.env.RESEARCH_SEARCH_PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
const result = spawnSync(python, ['scripts/package.py'], { stdio: 'inherit' });
if (result.error) console.error(result.error.message);
process.exitCode = result.status ?? 1;
