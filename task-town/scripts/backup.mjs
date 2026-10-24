import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { mysqlConfig } from '../src/database.mjs';
import { ensureLocalMySQL } from './local-mysql.mjs';
import { mysqlFile } from './mysql-tools.mjs';

if (existsSync('.env')) process.loadEnvFile('.env');
if (process.env.DB_MANAGED_LOCAL === 'true') await ensureLocalMySQL();
const name = `task-town-${new Date().toISOString().replace(/[:.]/g, '-')}.sql`;
const file = await mysqlFile(mysqlConfig(), process.argv[2] || join('backups', name));
console.log(`MySQL 一致性备份完成：${file}`);
