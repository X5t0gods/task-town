import { existsSync } from 'node:fs';
import { createApp } from './src/app.mjs';
import { ensureLocalMySQL } from './scripts/local-mysql.mjs';
import { networkInterfaces } from 'node:os';

if (existsSync('.env')) process.loadEnvFile('.env');
if (process.env.NODE_ENV === 'production' && !process.env.APP_ORIGIN?.startsWith('https://')) {
  throw new Error('生产环境需要配置 APP_ORIGIN=https://你的域名');
}
if (process.env.DB_MANAGED_LOCAL === 'true') await ensureLocalMySQL();
const app = await createApp();
const port = Number(process.env.PORT || 3000);
const host = process.env.HOST || '127.0.0.1';
app.server.listen(port, host, () => {
  console.log(`任务小镇已启动：http://${host === '0.0.0.0' ? 'localhost' : host}:${port}`);
  if (host === '0.0.0.0') {
    for (const [name, addresses] of Object.entries(networkInterfaces())) {
      if (/virtual|vEthernet|VMware|WSL|loopback/i.test(name)) continue;
      for (const address of addresses || []) if (address.family === 'IPv4' && !address.internal) console.log(`手机与电脑连接同一 Wi-Fi 后访问：http://${address.address}:${port}`);
    }
  }
});
let closing = false;
async function shutdown() {
  if (closing) return;
  closing = true;
  await app.close();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
