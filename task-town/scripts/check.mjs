import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

let count = 0;
function visit(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) visit(path);
    else if (/\.(mjs|js)$/.test(entry.name)) {
      const result = spawnSync(process.execPath, ['--check', path], { encoding: 'utf8' });
      if (result.status !== 0) throw new Error(result.stderr);
      count++;
    }
  }
}
for (const directory of ['src', 'public/js', 'scripts', 'tests']) visit(directory);
const result = spawnSync(process.execPath, ['--check', 'server.mjs'], { encoding: 'utf8' });
if (result.status !== 0) throw new Error(result.stderr);
for (const name of ['index', 'parent', 'kid']) {
  const html = readFileSync(`public/${name}.html`, 'utf8');
  const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]);
  if (new Set(ids).size !== ids.length) throw new Error(`${name}.html 有重复的元素 ID`);
  for (const match of html.matchAll(/(?:src|href)="((?:\/)?(?:js|css)\/[^"?#]+)"/g)) {
    if (!existsSync(resolve('public', match[1].replace(/^\//, '')))) throw new Error(`缺少资源 ${match[1]}`);
  }
}
console.log(`语法与页面资源检查通过（${count + 1} 个 JavaScript 文件，3 个页面）`);
