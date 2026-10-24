# 任务小镇 API v1

后端和网页同源，接口统一在 `/api/v1`，当前数据存储为本地 MySQL 8。所有写请求的请求体是 JSON，需设置 `Content-Type: application/json`。错误返回 `{"error":"可读的错误说明"}`，使用标准 HTTP 状态码：400 输入错误、401 未登录、403 校验失败、404 无可访问资源、409 状态冲突/余额不足、413 内容过大、429 限流。

## 登录与权限

家长和孩子使用独立 HttpOnly Cookie：`tt_parent` 和 `tt_kid`，生产环境带 Secure 和 SameSite=Strict。客户端应保存登录响应中的 Cookie，并在之后的请求中发送；网页已经自动处理。

登录后首先 GET `/{role}/snapshot`，从响应取得 `csrfToken`。所有登录后的写操作需带 `X-CSRF-Token` 请求头。家长接口只接受家长会话，孩子接口只接受孩子会话。客户端传入的余额、任务状态和身份字段不被信任；权限和星星数量均由服务端读取数据库决定。

家长会话 7 天过期，孩子会话 30 天过期。重设口令会撤销该孩子的全部会话；修改家长密码会撤销旧会话并为当前设备重新登录。不要将家长会话保存到孩子手表。

### 公开接口

| 方法 | 路径 | 请求/返回 |
| --- | --- | --- |
| GET | `/health` | `{ok:true}`，供存活检查 |
| GET | `/config` | 注册开关、时区、版本 |
| POST | `/auth/parent/register` | `{username,password,displayName,familyName}`；创建家庭并登录 |
| POST | `/auth/parent/login` | `{username,password}` |
| POST | `/auth/kid/login` | `{familyCode,loginName,pin}` |

家长账号 3–32 字符，孩子账号 2–32 字符，只允许字母、数字、下划线，忽略大小写。家长密码 8–128 字符；孩子口令必须是 6 位数字；家庭码为服务端生成的 10 位字符。

## 家长接口

以下路径均以 `/api/v1/parent` 开头。

| 方法 | 路径 | 请求体/行为 |
| --- | --- | --- |
| GET | `/snapshot` | 当前家长、家庭、孩子、任务、执行记录、愿望、兑换、流水、统计、时区、CSRF |
| POST | `/logout` | `{}`；退出当前设备 |
| POST | `/children` | `{displayName,loginName,pin}`；最多 20 位孩子 |
| POST | `/children/:id/pin` | `{pin}`；重设孩子口令 |
| POST | `/password` | `{currentPassword,newPassword}` |
| POST | `/tasks` | 发布任务，字段见下方 |
| PATCH | `/tasks/:id` | `{active:true或false}`；恢复/暂停 |
| POST | `/runs/:id/review` | `{decision:"approve"或"return",comment?}`；退回必须附留言 |
| GET | `/runs/:id/photo` | 登录后的私有照片二进制；不允许跨家庭访问 |
| POST | `/rewards` | `{title,price,icon}`；添加愿望 |
| PATCH | `/rewards/:id` | `{active:true或false}`；上/下架 |
| POST | `/redemptions/:id/review` | `{decision:"fulfilled"或"rejected",comment?}`；退回必须附留言 |
| GET | `/export` | 完整家庭业务记录 JSON，不含密码、会话或照片原文件 |

发布任务示例：

```json
{
  "childId": "孩子的 UUID",
  "title": "整理小书包",
  "description": "按课表检查课本，带上水杯。",
  "category": "自理小达人",
  "reward": 5,
  "recurrence": "daily",
  "dueAt": null,
  "photoRequired": false
}
```

类别：`家务小帮手`、`自理小达人`、`学习小标兵`、`运动小健将`、`爱心小天使`。任务星星为 1–1000 的整数。`recurrence` 为 `once` 或 `daily`；仅单次任务可以设置 `dueAt`，使用带时区的 ISO 8601 时间。任务标题最多 40 字符，说明最多 500 字符。

愿望价格为 1–100000 的整数，图标可选 `🎁 🍦 📺 🎡 📚 ⚽ 🧸 🎨`。

## 孩子接口

以下路径均以 `/api/v1/kid` 开头。服务端自动限定为当前孩子，无需传入孩子 ID。

| 方法 | 路径 | 请求体/行为 |
| --- | --- | --- |
| GET | `/snapshot` | 孩子余额、自己的任务与执行记录、家庭上架愿望、自己的兑换与流水、CSRF |
| POST | `/logout` | `{}` |
| POST | `/tasks/:id/claim` | `{}`；领取任务，返回 `{id}` 执行记录 ID |
| POST | `/runs/:id/submit` | `{note?,photo?}`；提交打卡，等待家长验收 |
| GET | `/runs/:id/photo` | 仅能读取自己执行记录的照片 |
| POST | `/redemptions` | `{rewardId,requestKey}`；申请兑换并扣星 |

`photo` 为 `data:image/jpeg;base64,...`、PNG 或 WebP data URL，解码后不超过 2MB，服务器会校验文件签名。JSON 请求体总上限为 3MB。必须拍照的任务不能只提交留言；每次退回重做后需重新上传照片。留言最多 300 字符。

申请兑换前，由客户端为本次确认动作生成一个至少 16 字符的 `requestKey`。**连接超时重试时重复使用同一个 key**，服务端返回同一条兑换记录，避免再次扣星。一次申请成功并得到响应后，下一次有意申请使用新的 key。原生手表应持久保存尚未确认结果的 key，避免断网重启后重复申请。

## 状态与同步

任务定义 `tasks` 与每次执行记录 `runs` 分开保存。每日任务使用家庭时区日期作为 `period_key`，单次使用 `once`；同一个任务同一个周期只能有一条执行记录。

```text
可领取 → claimed（进行中）→ submitted（待验收）→ approved（已完成）
                              ↓ 家长退回
                           claimed
```

家长通过验收、写入奖励流水、增加余额是一笔 MySQL InnoDB 原子事务；服务端使用行锁，重复通过不会再次加星。兑换状态为 `pending → fulfilled / rejected`，退回星星同样在事务中完成。

快照中 `tasks.current_status` 表示当前周期的状态；`current_run_id` 是当前周期执行记录，`expired` 表示单次领取期限已过。所有时间戳都是 UTC ISO 字符串，界面按响应中的 `timeZone` 显示。

网页在可见时每 5 秒 GET 一次快照。当前快照最多带最近 500 条执行记录、200 条兑换记录和 100 条流水；已领取和待验收记录优先展示，完整业务历史可由家长导出。首次手表开发可沿用轮询，后续根据电量、厂商网络能力再决定推送和连接策略。

原生手表接入顺序：孩子登录 → 保存 Cookie → 获取快照与 CSRF → 展示任务 → 领取 → 提交 → 轮询验收和余额。服务端不依赖浏览器 DOM，之后可以保留现有家长网页，仅替换孩子客户端。
