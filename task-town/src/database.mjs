import mysql from 'mysql2/promise';
import { AsyncLocalStorage } from 'node:async_hooks';
import { readFile } from 'node:fs/promises';

export function mysqlConfig(overrides = {}) {
  return {
    host: process.env.DB_HOST || '127.0.0.1', port: Number(process.env.DB_PORT || 3307),
    user: process.env.DB_USER || 'task_town_app', password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'task_town', charset: 'utf8mb4', timezone: 'Z',
    connectionLimit: 10, waitForConnections: true, queueLimit: 100,
    connectTimeout: 5000, supportBigNumbers: true, decimalNumbers: true,
    ...overrides,
  };
}

export async function openDatabase(overrides = {}) {
  const config = mysqlConfig(overrides);
  if (!/^[a-zA-Z0-9_]+$/.test(config.database)) throw new Error('数据库名只能包含英文字母、数字和下划线');
  const pool = mysql.createPool(config);
  const context = new AsyncLocalStorage();
  try {
    await pool.query('SELECT 1');
    const schema = await readFile(new URL('../database/schema.sql', import.meta.url), 'utf8');
    for (const statement of schema.split(';').map((s) => s.trim()).filter(Boolean)) await pool.query(statement);
  } catch (error) { await pool.end(); throw error; }
  return {
    pool, context, config,
    prepare(sql) {
      const execute = async (values) => (await (context.getStore() || pool).execute(sql, values))[0];
      return {
        get: async (...values) => (await execute(values))[0],
        all: async (...values) => execute(values),
        run: async (...values) => execute(values),
      };
    },
    exec: async (sql) => (await (context.getStore() || pool).query(sql))[0],
    close: () => pool.end(),
  };
}

export async function transaction(db, callback) {
  if (db.context.getStore()) throw new Error('不支持嵌套事务');
  const connection = await db.pool.getConnection();
  try {
    await connection.beginTransaction();
    const result = await db.context.run(connection, callback);
    await connection.commit();
    return result;
  } catch (error) { await connection.rollback(); throw error; }
  finally { connection.release(); }
}
