import mysql from 'mysql2/promise';
import { randomBytes, createHash } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync, readFileSync, openSync, closeSync, unlinkSync, realpathSync } from 'node:fs';
import { resolve, dirname, join, sep, parse } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';

const root = fileURLToPath(new URL('../', import.meta.url));
const privateDir = join(root, '.local');
const configFile = join(privateDir, 'mysql.json');
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
export function readLocalConfig() {
  if (!existsSync(configFile)) throw new Error('请先运行 npm run setup:local 初始化本项目专属 MySQL');
  return JSON.parse(readFileSync(configFile, 'utf8'));
}
export async function localAdmin(database) {
  const config = readLocalConfig();
  return mysql.createConnection({ host: '127.0.0.1', port: config.port, user: 'root', password: config.rootPassword, database, connectTimeout: 3000, charset: 'utf8mb4' });
}

export async function ensureLocalMySQL() {
  const config = readLocalConfig();
  if (!config.instanceDir || !resolve(config.dataDir).startsWith(resolve(config.instanceDir) + sep)) throw new Error('MySQL 实例目录配置不正确');
  try { const connection = await localAdmin(); await connection.end(); return; }
  catch (error) { if (error.code !== 'ECONNREFUSED') throw new Error(`项目 MySQL 无法连接：${error.code}，请检查 ${config.port} 端口`); }
  const args = ['--no-defaults', `--basedir=${dirname(dirname(config.mysqldPath))}`, `--datadir=${config.dataDir}`,
    `--port=${config.port}`, '--bind-address=127.0.0.1', '--mysqlx=OFF', '--skip-log-bin',
    '--innodb-buffer-pool-size=64M', '--max-connections=50', '--character-set-server=utf8mb4',
    '--collation-server=utf8mb4_unicode_ci', '--default-time-zone=+00:00', '--local-infile=0',
    `--pid-file=${join(config.instanceDir, 'mysqld.pid')}`, `--log-error=${join(config.instanceDir, 'mysql-error.log')}`];
  const initFile = join(config.instanceDir, 'mysql-init.sql');
  if (existsSync(initFile)) args.push(`--init-file=${initFile}`);
  const output = openSync(join(config.instanceDir, 'mysql-process.log'), 'a');
  const child = spawn(config.mysqldPath, args, { detached: true, windowsHide: true, stdio: ['ignore', output, output] });
  let launchError;
  child.on('error', (error) => { launchError = error; });
  child.on('exit', (code) => { launchError = new Error(`mysqld 已退出，代码 ${code}`); });
  child.unref(); closeSync(output);
  for (let attempt = 0; attempt < 60; attempt++) {
    await delay(500);
    if (launchError) throw new Error(`MySQL 启动失败，请查看 ${join(config.instanceDir, 'mysql-error.log')}`);
    try { const connection = await localAdmin(); await connection.end(); if (existsSync(initFile)) unlinkSync(initFile); return; }
    catch { /* The server is still starting. */ }
  }
  throw new Error(`MySQL 启动未完成，请查看 ${join(config.instanceDir, 'mysql-error.log')}`);
}

async function setup() {
  mkdirSync(privateDir, { recursive: true });
  if (!existsSync(configFile)) {
    const detected = spawnSync('where.exe', ['mysqld.exe'], { encoding: 'utf8', windowsHide: true });
    const mysqldPath = process.env.MYSQLD_PATH || detected.stdout?.trim().split(/\r?\n/)[0];
    if (!mysqldPath || !existsSync(mysqldPath)) throw new Error('未找到 mysqld.exe，请安装 MySQL 8.0/8.4 或设置 MYSQLD_PATH');
    // Windows MySQL cannot reliably use a data directory with Chinese characters.
    const instanceDir = /^[\x00-\x7F]*$/.test(root) ? join(root, '.local-mysql')
      : join(parse(root).root, 'TaskTownLocal', `task-town-${createHash('sha256').update(resolve(root)).digest('hex').slice(0, 10)}`);
    if (existsSync(instanceDir)) throw new Error('专属实例目录已存在但缺少项目配置，为保护数据已停止初始化');
    mkdirSync(instanceDir, { recursive: true });
    if (process.platform === 'win32') {
      const principal = `${process.env.USERDOMAIN}\\${process.env.USERNAME}:(OI)(CI)F`;
      const permission = spawnSync('icacls.exe', [instanceDir, '/inheritance:r', '/grant:r', principal], { encoding: 'utf8', windowsHide: true });
      if (permission.status !== 0) throw new Error('无法为项目数据库设置当前用户的私有目录权限');
    }
    const config = { mysqldPath, instanceDir, dataDir: join(instanceDir, 'data'), port: 3307,
      rootPassword: randomBytes(24).toString('hex'), appPassword: randomBytes(24).toString('hex') };
    writeFileSync(configFile, JSON.stringify(config, null, 2), { mode: 0o600 });
    const result = spawnSync(mysqldPath, ['--no-defaults', '--initialize-insecure', `--basedir=${dirname(dirname(mysqldPath))}`, `--datadir=${config.dataDir}`], { encoding: 'utf8', windowsHide: true });
    if (result.status !== 0) throw new Error(`MySQL 初始化失败：${result.stderr || result.error?.message}`);
    const statements = [
      `ALTER USER 'root'@'localhost' IDENTIFIED BY '${config.rootPassword}'`,
      'CREATE DATABASE IF NOT EXISTS task_town CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci',
      'CREATE DATABASE IF NOT EXISTS task_town_demo CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci',
      `CREATE USER IF NOT EXISTS 'task_town_app'@'127.0.0.1' IDENTIFIED BY '${config.appPassword}'`,
      "GRANT ALL PRIVILEGES ON task_town.* TO 'task_town_app'@'127.0.0.1'",
      "GRANT ALL PRIVILEGES ON task_town_demo.* TO 'task_town_app'@'127.0.0.1'",
    ];
    writeFileSync(join(instanceDir, 'mysql-init.sql'), `${statements.join(';\n')};\n`, { mode: 0o600 });
  }
  await ensureLocalMySQL();
  const config = readLocalConfig();
  const envPath = join(root, '.env');
  if (!existsSync(envPath)) writeFileSync(envPath, [
    'HOST=0.0.0.0', 'PORT=3000', 'DB_MANAGED_LOCAL=true', 'DB_HOST=127.0.0.1', `DB_PORT=${config.port}`,
    'DB_USER=task_town_app', `DB_PASSWORD=${config.appPassword}`, 'DB_NAME=task_town',
    'APP_TIMEZONE=Asia/Shanghai', 'COOKIE_SECURE=false', 'TRUST_PROXY=false', 'REGISTRATION_OPEN=true', '',
  ].join('\n'), { mode: 0o600 });
  console.log(`项目专属 MySQL 已就绪：127.0.0.1:${config.port}\n数据目录：${config.dataDir}\n连接配置已保存到本地 .env，原有系统 MySQL 服务未改变。`);
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  try {
    if (process.argv[2] === 'stop') { const connection = await localAdmin(); await connection.query('SHUTDOWN'); await connection.end(); console.log('项目专属 MySQL 已停止'); }
    else await setup();
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
