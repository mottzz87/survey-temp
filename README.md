# ops-survey

轻量、通用、可配置的 Survey / 投票系统。

- **单个 Node.js 服务**（原生 `http` API，零 npm 依赖）
- **HTML 前端**（原生 HTML/CSS/JS，无构建步骤）
- **JSON 文件存储**（每个 Survey 一个文件，`tmp 文件 + rename` 原子写入）
- **配置驱动**：新增问卷只需在 `config.json` 加一段配置，不用改代码

---

## 1. 项目结构

```
ops-survey/
├── server.js           # 核心服务：路由 / 配置 / 数据 / 统计 / API / 认证
├── package.json        # 零依赖
├── config.json         # 所有 Survey 的配置 + 管理员 token
├── data/               # 每个 Survey 一个 JSON 文件
│   ├── 583721.json
│   └── ...
├── public/
│   ├── index.html      # 普通用户问卷页
│   └── admin.html      # 管理员结果页（token 认证）
├── Dockerfile
├── docker-compose.yml
└── README.md
```

---

## 2. 快速开始（本地）

```bash
cd ops-survey
node server.js
# 或
npm start
```

监听 `127.0.0.1:3010`（默认，可改 `config.json` 的 `server.port` / `server.host`）。

| 用途 | URL |
| --- | --- |
| 问卷列表 | http://127.0.0.1:3010/survey/ |
| 问卷页面 | http://127.0.0.1:3010/survey/583721/ |
| 管理员结果页 | http://127.0.0.1:3010/survey/api/583721/result |

---

## 3. URL 路由

统一结构：

```
GET   /survey/:surveyId/           普通用户问卷页（HTML）
GET   /survey/                     问卷列表（HTML）
GET   /health                      健康检查

GET   /survey/api/:surveyId/public      公开信息（不含任何选项计数）
POST  /survey/api/:surveyId/vote        提交 / 修改回答
GET   /survey/api/:surveyId/my-vote?voterId=...   查询自己的回答
GET   /survey/api/:surveyId/result      管理员结果页（HTML） / 结果 JSON
```

### 结果页的两种返回方式（同一个 URL）

- 浏览器直接打开 → 返回 HTML 管理页（含 token 输入框）
- 请求带 `Accept: application/json` 或 `?format=json` → 返回 JSON 统计

```bash
curl -s -H "Authorization: Bearer <TOKEN>" \
     -H "Accept: application/json" \
     http://127.0.0.1:3010/survey/api/583721/result
```

结果 JSON 结构（每个问题一组统计）：

```json
{
  "surveyId": "583721",
  "title": "水辺｜平日午前、何時ならテニスできますか？",
  "totalVoters": 37,
  "questions": [
    {
      "id": "weekday",
      "title": "都合の良い曜日",
      "options": [
        { "id": "mon", "label": "月曜日", "count": 21, "percentage": 56.8 }
      ],
      "ranking": [ ... ],
      "mostPopular": { "id": "wed", "label": "水曜日", "count": 31 }
    },
    {
      "id": "time",
      "title": "都合の良い時間帯",
      "options": [ ... ]
    }
  ],
  "collectedAt": "2026-08-18T00:00:00.000Z"
}
```

`percentage = count / totalVoters * 100`，保留 1 位小数。

### 公开 API 绝不泄露统计

`/survey/api/:surveyId/public` **只返回总人数**，即使浏览器开发者工具也拿不到每个选项的计数：

```json
{
  "surveyId": "583721",
  "title": "...",
  "questions": [
    { "id": "weekday", "title": "都合の良い曜日", "options": [{ "id": "mon", "label": "月曜日" }] },
    { "id": "time", "title": "都合の良い時間帯", "options": [{ "id": "08-09", "label": "08:00 ～ 09:00" }] }
  ],
  "totalVoters": 37
}
```

只有 Survey 显式配置 `"showResultsToPublic": true` 时，public API 才会附带计数（供主动公开结果的问卷使用）。

---

## 4. 管理员认证

`config.json` 顶层：

```json
{
  "admin": {
    "enabled": true,
    "token": "请改成强随机字符串"
  }
}
```

- `enabled: true` → result 页面/API 需要 token
- `enabled: false` → result 完全公开（不推荐）
- 支持 `Authorization: Bearer <token>` 或 `?token=<token>` 两种方式
- token 由管理员在结果页输入后存入浏览器 `localStorage`，**不会硬编码在前端**
- 可给单个 Survey 覆盖：`"583721": { ..., "admin": { "enabled": true, "token": "..." } }`

> ⚠️ 部署后请立即把 `CHANGE_ME_ADMIN_TOKEN` 改成强随机字符串。
> 服务器启动时检测到默认 token 会打印警告。

---

## 5. 投票逻辑

- **一个 voterId = 一个用户**，同一 voterId 重复提交只更新原记录，不会重复计数
- 一个问卷可以包含多个问题（`questions`），每个问题支持多选 / 单选（`allowMultiple`）
- 提交格式：`answers: { "<questionId>": ["optionId", ...] }`，每个问题独立校验
- 统计时：每个问题里每个选中的选项 +1；`totalVoters` 按 voterId 去重
- `percentage = count / totalVoters * 100`（1 位小数）
- 同一用户可随时修改回答（`allowRevote`，默认 true）

### voterId

前端首次打开问卷时用 `crypto.randomUUID()` 生成，存入：

```
localStorage: survey_voter_id_583721
```

不同 Survey 用不同 key（`survey_voter_id_<surveyId>`），互不影响。

---

## 6. 数据存储

每个 Survey 一个文件，`data/<surveyId>.json`：

```json
{
  "meta": { "surveyId": "583721" },
  "voters": {
    "2f8a...-uuid": {
      "name": "clark",
      "answers": {
        "weekday": ["mon", "wed"],
        "time": ["08-09", "09-10"]
      },
      "createdAt": "2026-08-18T00:00:00.000Z",
      "updatedAt": "2026-08-18T01:00:00.000Z"
    }
  }
}
```

写入使用 `tmp 文件 + rename`（`writeData`），避免直接覆盖导致数据损坏。

> 兼容旧格式：升级前旧数据里的 `answers: ["08-09", ...]`（数组）会被系统自动迁移到对应问题，无需手工改文件。

---

## 7. config.json 参考

```jsonc
{
  "server": {
    "host": "127.0.0.1",
    "port": 3010,
    "maxBodyBytes": 16384,        // request body 上限
    "rateLimit": { "votePerMinute": 20 }   // 每 IP 每分钟最多 vote 次数
  },
  "admin": {
    "enabled": true,
    "token": "CHANGE_ME_ADMIN_TOKEN"
  },
  "surveys": {
    "583721": {
      "enabled": true,
      "title": "水辺｜平日午前、何時ならテニスできますか？",
      "description": ["第一行", "第二行", "空字符串会渲染为空白行"],

      "collectName": true,        // 是否收集昵称
      "requireName": false,       // 昵称是否必填（或 allowAnonymous:false）
      "allowAnonymous": true,     // false 时昵称必填
      "showTotalVoters": true,    // 页面/公开API 是否显示总回答人数
      "showResultsToPublic": false, // true 时公开API附带计数（默认禁止）
      "allowRevote": true,        // 是否允许用户修改回答
      "startAt": null,            // 开始时间 ISO 字符串，如 "2026-09-01T00:00:00+09:00"
      "endAt": null,              // 结束时间
      "thankYouText": "回答ありがとうございます！",

      "questions": [
        {
          "id": "weekday",
          "title": "都合の良い曜日",
          "allowMultiple": true,   // true=多选  false=单选
          "minSelections": 1,      // 最少选择数（0 = 可不回答）
          "maxSelections": null,   // 最多选择数（null=不限制）
          "options": [
            { "id": "mon", "label": "月曜日" },
            { "id": "tue", "label": "火曜日" },
            { "id": "wed", "label": "水曜日" },
            { "id": "thu", "label": "木曜日" },
            { "id": "fri", "label": "金曜日" },
            { "id": "sat", "label": "土曜日" },
            { "id": "sun", "label": "日曜日" }
          ]
        },
        {
          "id": "time",
          "title": "都合の良い時間帯",
          "allowMultiple": true,
          "options": [
            { "id": "08-09", "label": "08:00 ～ 09:00" },
            { "id": "09-10", "label": "09:00 ～ 10:00" }
          ]
        }
      ]
    }
  }
}
```

`questions` 里每个问题的 `options` 也可以直接写字符串数组：`["月曜日", ...]`，系统会自动编号。

### 向后兼容（旧版单个 options）

如果 Survey **没有** `questions`，系统会自动把它当成一个单问题问卷，直接写顶层字段即可（旧配置无需改动）：

```jsonc
"583722": {
  "enabled": true,
  "title": "打ち合わせは何曜日が都合が良いですか？",
  "allowMultiple": false,
  "collectName": false,
  "options": [
    { "id": "mon", "label": "月曜" },
    { "id": "tue", "label": "火曜" },
    { "id": "wed", "label": "水曜" }
  ]
}
```

### 新增一个 Survey

只需要在 `config.json` 的 `surveys` 下加一段（服务会在文件 mtime 变化后自动重新加载，无需重启）：

```jsonc
"888888": {
  "enabled": true,
  "title": "〇〇についてのアンケート",
  "questions": [
    { "id": "q1", "title": "好きなものは？", "options": ["A", "B", "C"] }
  ]
}
```

---

## 8. 部署

### 方式 A：PM2（推荐，单机简单）

```bash
cd /home/admin/apps/ops-survey
pm2 start server.js --name ops-survey --cwd /home/admin/apps/ops-survey
pm2 save
# 开机自启（会输出需要以 root 执行的命令）
pm2 startup
```

### 方式 B：docker-compose

```bash
cd /home/admin/apps/ops-survey
docker compose up -d --build
```

- 端口绑定 `127.0.0.1:3010`，外部无法直接访问
- `./data` 与 `./config.json` 挂载到宿主机：改配置 / 升级不丢数据

### Nginx（`ops.nnde.de`）

在已有 `server { server_name ops.nnde.de; }` 块内**追加**（不要动现有 `/logs/`）：

```nginx
location /survey/ {
    proxy_pass http://127.0.0.1:3010;
    proxy_http_version 1.1;

    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;

    proxy_read_timeout 30s;
    client_max_body_size 1m;
}
```

⚠️ 注意 `proxy_pass` 后面**不要**加 `/`，否则 `/survey/` 前缀会被剥掉。

```bash
nginx -t && systemctl reload nginx
```

之后可访问：

- https://ops.nnde.de/survey/583721/
- https://ops.nnde.de/survey/api/583721/result

### 安全说明

- `voterId` 去重，同一 IP 每分钟最多 20 次 vote（可配）
- request body 上限、surveyId / option / name / 答案数量全部校验
- 公开 API 不含任何选项计数
- 建议 Nginx 层再套一层 `limit_req`，并根据需要把 result 路径换成 nginx Basic Auth（代码里认证是独立函数，便于替换）

---

## 9. 测试 curl 命令

```bash
BASE=http://127.0.0.1:3010
TOKEN=CHANGE_ME_ADMIN_TOKEN

# 1) 公开信息（不含计数）
curl -s $BASE/survey/api/583721/public

# 2) 投票（首次，多问题格式：weekday + time）
curl -s -X POST $BASE/survey/api/583721/vote \
  -H 'Content-Type: application/json' \
  -d '{"voterId":"test-user-0001","name":"clark","answers":{"weekday":["mon","wed"],"time":["08-09","09-10"]}}'

# 3) 同一 voterId 再次提交 = 更新原回答，不新增用户
curl -s -X POST $BASE/survey/api/583721/vote \
  -H 'Content-Type: application/json' \
  -d '{"voterId":"test-user-0001","name":"clark","answers":{"weekday":["mon","wed"],"time":["08-09","09-10","10-11"]}}'

# 4) 查询自己的回答
curl -s "$BASE/survey/api/583721/my-vote?voterId=test-user-0001"

# 5) 结果（管理员 token，含每个问题的统计）
curl -s -H "Authorization: Bearer $TOKEN" -H "Accept: application/json" \
  $BASE/survey/api/583721/result

# 6) 无 token 访问结果 -> 401
curl -s -o /dev/null -w "%{http_code}\n" -H "Accept: application/json" \
  $BASE/survey/api/583721/result

# 7) 公开 API 绝不能有 count —— 下面应输出 0
curl -s $BASE/survey/api/583721/public | grep -c '"count"'

# 8) 非法 option -> 400
curl -s -X POST $BASE/survey/api/583721/vote \
  -H 'Content-Type: application/json' \
  -d '{"voterId":"test-user-0002","answers":{"weekday":["mon"],"time":["99-99"]}}'

# 9) 问卷页面 HTML
curl -s $BASE/survey/583721/ | head -n 5
```

---

## 10. 目录 / 说明速查

| 文件 | 说明 |
| --- | --- |
| `server.js` | 路由、配置读取、数据读写、校验、统计、API、页面渲染 |
| `config.json` | 所有 Survey 配置与管理员 token |
| `public/index.html` | 用户问卷页（移动优先，零依赖） |
| `public/admin.html` | 管理员结果页（token 门禁、CSS 柱状图、排名、自动刷新） |
| `data/*.json` | 每个 Survey 的投票数据 |

许可证：MIT
