# 任务小镇 · Sites 线上版

这是独立的线上版本，保留家长与孩子页面、手机布局、任务发布与验收、星星奖励、愿望兑换、照片和家庭记录导出。

- 网站：[任务小镇](https://task-town-family.shrewdmoose128.chatgpt.site/)。当前站点已开放公开访问，家庭数据仍需要项目账号登录后访问。
- 数据：Sites D1（`DB`）；照片：私有 R2（`BUCKET`），通过角色鉴权接口读取。
- 原来的 `../task-town` 仍使用本地 MySQL，本项目不连接、复制或修改本地业务数据。
- 新站没有预设演示账号。首次在家长端创建家庭，再添加孩子并取得家庭码。
- GitHub 源码副本中的 `.openai/hosting.json` 只保留数据库和存储绑定名称，不包含原站点的项目身份。部署自己的站点前，应创建新 Sites 项目并填写其 `project_id`；原站点的访问权限应在 Sites 中管理。

## 实现与维护

静态页面位于 `public/`，后端位于 `lib/town-api.mjs`。保留官方 Vinext / Sites 构建集成，`build/sites-worker.ts` 将 `/api/v1` 交给业务接口。

账号使用带随机盐的 PBKDF2-SHA256（100000 次）哈希；家长与孩子使用独立的 HttpOnly 会话 Cookie。角色、家庭、CSRF 和同源操作由后端校验。会话绑定当前密码哈希，修改密码或孩子口令后旧会话失效。

数据库迁移来自 `db/schema.ts`。初始迁移中的余额触发器来自 `db/ledger-triggers.sql`：验收、扣星和退款在同一 SQLite 原子写入中完成；唯一约束和条件更新防止重复操作。触发器不在请求时创建。已部署迁移不可修改，后续变更应追加迁移。

照片最多 2MB，先写入独立随机 R2 对象，再条件提交打卡；提交失败时回收新对象。照片不使用公开桶地址。不同家庭和孩子不能读取他人的照片。

## 本地验证

克隆后先运行 `npm ci` 安装依赖。常用检查：

```text
node --test tests/cloud.test.mjs
npm run build
```

测试使用临时 Miniflare D1 / R2，不连接线上库和本地 MySQL。

本地预览前需构建，并按官方模板 README 将初始迁移应用到 `.wrangler/state`。运行 `npm start -- --port 5173` 可预览构建产物。

发布流程：检查 → 构建 → Sites source helper 推送并打包 → 保存和部署确切版本 → 检查部署结果。不要上传 `.env`、`.sites-runtime`、`.wrangler`、账号会话或本地数据库。
