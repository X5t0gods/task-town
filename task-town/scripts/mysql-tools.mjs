import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, writeFileSync, unlinkSync, createReadStream, createWriteStream, mkdirSync, renameSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { readLocalConfig } from './local-mysql.mjs';

export async function mysqlFile(config, filename, restore = false) {
  if (!/^[a-zA-Z0-9_]+$/.test(config.database)) throw new Error('数据库名不正确');
  const local = readLocalConfig();
  const optionsFile = join(local.instanceDir, `client-${randomUUID()}.cnf`);
  const password = config.password.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('\n', '\\n').replaceAll('\r', '\\r');
  writeFileSync(optionsFile, `[client]\npassword="${password}"\n`, { mode: 0o600 });
  const target = resolve(filename);
  const partial = `${target}.${randomUUID()}.partial`;
  const program = join(dirname(local.mysqldPath), restore ? 'mysql.exe' : 'mysqldump.exe');
  const args = [`--defaults-extra-file=${optionsFile}`, '--host=127.0.0.1', `--port=${config.port}`, `--user=${config.user}`, '--default-character-set=utf8mb4'];
  if (restore) args.push('--binary-mode', config.database);
  else args.push('--single-transaction', '--quick', '--hex-blob', '--skip-lock-tables', '--no-tablespaces', '--set-gtid-purged=OFF', '--column-statistics=0', config.database);
  try {
    if (!restore && existsSync(target)) throw new Error('备份文件已存在，请换一个名字');
    if (!restore) mkdirSync(dirname(target), { recursive: true });
    const child = spawn(program, args, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let errorText = '';
    child.stderr.on('data', (chunk) => { errorText += chunk.toString(); });
    const exited = new Promise((r, reject) => { child.once('error', reject); child.once('close', r); });
    if (restore) { child.stdout.resume(); await pipeline(createReadStream(target), child.stdin); }
    else { child.stdin.end(); await pipeline(child.stdout, createWriteStream(partial, { flags: 'wx', mode: 0o600 })); }
    const code = await exited;
    if (code !== 0) throw new Error(`MySQL 工具执行失败：${errorText.replaceAll(config.password, '[redacted]')}`);
    if (!restore) renameSync(partial, target);
    return target;
  } finally {
    if (existsSync(optionsFile)) unlinkSync(optionsFile);
    if (existsSync(partial)) unlinkSync(partial);
  }
}
