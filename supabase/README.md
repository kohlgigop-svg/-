# 云端共享配置指南

本工具默认把数据存在**本机浏览器**。按下面的步骤配置后，数据会存到 **Supabase**（免费层足够），
同一访问码下的所有成员即可共享全部项目与记录。

全程约 10 分钟，只需要做一次。

> ### ⚠️ 关于默认访问码（请务必读）
>
> 本仓库里的 `schema.sql` 使用的默认访问码是 `qc-eval-2026`，而**本仓库是公开的**。
> 也就是说：知道这个默认码 + 你的 anon key，就能读写你的数据。
>
> **正式使用前请改成只有你团队知道的访问码**，方法：
>
> 1. 在浏览器按 `F12` → Console，运行（把 `你的新访问码` 换掉）：
>    ```js
>    crypto.subtle.digest('SHA-256', new TextEncoder().encode('你的新访问码'))
>      .then(b => console.log([...new Uint8Array(b)].map(x => x.toString(16).padStart(2,'0')).join('')))
>    ```
> 2. 复制打印出的 64 位字符串
> 3. Supabase → SQL Editor 执行（把那串哈希换进去）：
>    ```sql
>    create or replace function public.qc_access_ok(code text)
>    returns boolean language plpgsql stable security definer
>    set search_path = public, extensions as $$
>    begin
>      return encode(digest(coalesce(code, ''), 'sha256'), 'hex') =
>             '把这里换成你的新哈希';
>    end; $$;
>    ```
> 4. 工具「设置 → 云端共享 → 访问码」改成新访问码，重新连接
>
> 提示：访问码只存哈希在数据库里，数据库被导出也不会泄漏明文。

---

## 为什么需要你自己配置

数据存在**你自己的 Supabase 项目**里，工具本身不经过任何第三方服务器中转：

- 你的数据库、你的数据，工具的开发者（包括我）无法访问
- 免费层容量足够：一条记录约 2~4 KB，5000 条记录约 15 MB，远低于免费额度
- 页面是纯静态的，不需要服务器；`anon key` 配合数据库行级权限使用是安全的

---

## 第一步：创建 Supabase 项目

1. 打开 https://supabase.com ，用邮箱注册（免费）
2. 点 **New project**
   - **Name**：随便填，如 `qc-eval`
   - **Database Password**：随便设一个强密码，**记下来**（后面基本不会用到）
   - **Region**：选离你最近的，例如 `Southeast Asia (Singapore)`
3. 等 1~2 分钟，项目初始化完成

---

## 第二步：建表（执行 SQL）

1. 左侧菜单 → **SQL Editor** → **New query**
2. 打开本目录下的 `schema.sql`，**全文复制**粘贴进去
3. **重要**：把第一段里 `qc_access_ok` 函数的那个 64 位哈希，换成**你自己访问码**的哈希

   怎么算你的访问码哈希？在浏览器按 `F12` 打开控制台（Console），粘贴运行：

   ```js
   crypto.subtle.digest('SHA-256', new TextEncoder().encode('你的访问码'))
     .then(b => console.log([...new Uint8Array(b)].map(x => x.toString(16).padStart(2,'0')).join('')))
   ```

   会打印出一串 64 位十六进制字符，把它替换到 `schema.sql` 里那个哈希位置。

   > 默认访问码是 `qc-eval-2026`，对应的哈希已经填好了。**建议改掉**，否则知道这个默认码的人都能读写你的数据。

4. 点右下角 **Run**（或按 Ctrl+Enter）
5. 看到 `Success. No rows returned` 就成功了

### 自检（可选但推荐）

在同一个 SQL Editor 里执行（把 `你的访问码` 换成真实值）：

```sql
select public.qc_check_access('你的访问码');   -- 期望 true
select public.qc_check_access('随便乱填');      -- 期望 false
select public.qc_fetch_all('你的访问码');       -- 期望 []
```

---

## 第三步：打开匿名登录

工具用「匿名登录」来区分不同成员的提交（这样才能实现"只能改删自己的记录"）。

1. 左侧菜单 → **Authentication** → **Sign In / Providers**
2. 找到 **Anonymous sign-ins**，打开开关
3. 保存

> 说明：匿名登录只是给每个浏览器分配一个随机 ID，**不收集任何个人信息**，不需要邮箱或手机号。

---

## 第四步：取两个参数填进工具

1. 左侧菜单 → **Project Settings**（齿轮图标）→ **API**
2. 复制这两个值：
   - **Project URL**：形如 `https://abcdefgh.supabase.co`
   - **anon public key**：形如 `eyJhbGciOi...`（很长的一串，选 `anon` / `public` 那个，**不是** `service_role`）

3. 打开工具页面 → 右上角 **设置** → 找到「云端共享」区域：
   - **Supabase URL**：粘贴 Project URL
   - **anon key**：粘贴 anon public key
   - **访问码**：填你第二步设定的访问码
   - 点 **测试并连接**

连接成功后，页面底部会显示「云端已连接」，之后：

- 保存记录时会**同时**存到云端与本机
- 切换项目或刷新页面时自动拉取云端最新数据
- 项目下拉框会显示云端所有成员的项目

> ⚠️ **绝对不要**把 `service_role` key 填进来。它有绕过所有权限的完全控制权，一旦泄漏等于数据库被完全接管。工具只需要 `anon` key。

---

## 使用约定（重要）

### 共享范围

- 同一访问码下的所有人，**能看到全部项目和全部记录**
- **保存记录**：人人可提交
- **修订记录**：只能改自己提交的那条（同项目同周期重复提交视为修订）
- **删除记录**：只能删自己提交的
- **删除项目**：只有当项目下没有他人记录时才能删

### 谁的记录算数

**警戒线（R_min）与观察线取「该项目下的全部记录」**，不分提交者。理由：

- 警戒线是项目级的判定阈值，应该反映**项目整体的质量水平**，各人一把尺子会让判定失去可比性
- 观察线是趋势参照，项目级记录数更多，中位数更稳健

> 但请注意一个真实的副作用：**如果多人同时往一个项目里提交记录，历史会比较混杂**。
> 如果某个质检员只在自己的周期里出现，他的历史会被别人的数据稀释。
> 需要个人级基线时，建议**为每个质检员单独建项目**（例如 `XX项目-张三`），这样取数自然就是个人的。

### 数据安全提醒

- 数据在你的 Supabase 项目里，**请自行做好备份**（工具仍保留「导出全部」功能，可导出 JSON）
- 免费层项目**长时间无访问可能被暂停**，恢复即可，数据不会丢
- 访问码是唯一的门槛，**请通过可靠渠道（如内部群、当面）分发，不要贴在公开网页上**
- 由于是匿名访问，任何人拿到「访问码 + anon key + Project URL」就能读写。如果这个风险不可接受，需要改用带账号体系的方案（此时应改为服务端代理或真实登录）

---

## 方案 C：Edge Function 代理 AI 调用（API Key 不落前端，全员零输入）

这是最推荐的部署方式：**DeepSeek 的 API Key 只存在于 Supabase 服务端**，前端、仓库、浏览器里都不出现，
成员打开页面即可使用 AI 分析，**不需要填任何东西**。

### 为什么需要它

前端直连模型时，Key 必然存在于浏览器里，任何人 F12 就能抄走并消耗你的额度。
把调用搬到服务端后，浏览器只发请求给 Edge Function，Key 由服务端注入。

### 部署步骤（控制台操作，约 5 分钟）

**1. 创建函数**

1. Supabase 控制台 → 左侧 **Edge Functions**
2. 点 **Deploy a new function** → 选 **Via Editor**（不要选 CLI）
3. 函数名填：`ai-proxy`（**必须完全一致**）
4. 把 `supabase/functions/ai-proxy/index.ts` 的内容**全文粘贴**进编辑器
5. 点 **Deploy**，等状态变成 `ACTIVE`

> 若编辑器不支持相对路径 import（`./handler.js`），把 `handler.js` 的内容也一起粘进
> `index.ts`（把 `import` 那行删掉，两个文件拼成一个即可）。

**2. 添加四个密钥（Secrets）**

在 Edge Functions 页面 → **Secrets**（或 Project Settings → Edge Functions → Secrets），逐个添加：

| 名称 | 值 |
|---|---|
| `DEEPSEEK_API_KEY` | `sk-` 开头的真实 Key |
| `ACCESS_CODE_HASH` | `2b3ac575436c0f15e2eae20a595c9b868fe47c3e0bd5c9228a870adbcf8af5d1` |
| `SUPABASE_URL` | `https://ofdtgchdkhgvksuohzoq.supabase.co` |
| `SUPABASE_ANON_KEY` | 你的 anon public key |

> `ACCESS_CODE_HASH` 就是访问码 `qc-eval-2026` 的 SHA-256，与数据库里用的**是同一个哈希**。
> 若你改过访问码，用同样的方法重新算（见文首说明）。

**3. 确认前端指向代理**

`config.js` 里的 `aiProxyUrl` 已经填好：

```
https://ofdtgchdkhgvksuohzoq.supabase.co/functions/v1/ai-proxy
```

管理员在本机「设置 → AI 分析」里也能看到这一项（已锁定，成员不可改）。
工具会自动识别为「服务端代理」模式，并**隐藏 API Key 输入框**——因为已经不需要了。

### 安全设计（本函数已实现并有测试覆盖）

| 机制 | 作用 |
|---|---|
| Key 只在服务端环境变量 | 响应体中任何情况下都不含 Key（有专门测试断言） |
| 访问码在服务端比对 SHA-256 | 明文访问码既不进数据库也不进代码 |
| 校验 Supabase 会话 | 必须带有效匿名登录令牌，提高滥用门槛 |
| 模型白名单 | 只允许 `deepseek-flash` / `deepseek-v4-pro`，防止被拿去调其它昂贵模型 |
| `max_tokens` 上限 32000 | 防止有人用超大预算刷额度 |
| 请求体上限 256 KB | 防止超大请求 |
| CORS 白名单 | 只允许你自己的站点来源，未知来源不回显 |

### 验证部署是否成功

在浏览器打开你的工具页面 → 「设置」→ 关掉再打开，确认「AI 代理地址」已填好且不可编辑；
然后点结果区的「生成分析」。成功时状态行会显示 **「服务端代理」** 字样。

若失败，状态行会给出去向明确的提示（如 `NO_SESSION` 会提示先去连云端取得会话）。

> 仍需做的最后一道保险：到 DeepSeek 控制台**设置每月消费上限**。

---

## 日常运维（长期使用必读）

### 孤儿数据：唯一需要人工介入的情形

记录归属由**浏览器的匿名会话**决定。以下情况会产生「孤儿数据」——**任何人都无法修订或删除，连带项目也删不掉**（因为项目下存在"他人"记录）：

- 成员清除了浏览器数据或换了设备
- 成员离职
- 电脑重装

**处理办法**：在 Supabase → SQL Editor 里执行（把访问码换成你的）：

```sql
-- 情况一：清理指定项目（UUID 从 qc_fetch_all 结果里取）
select public.qc_admin_cleanup('qc-eval-2026', 'CONFIRM_DELETE', '项目UUID');

-- 情况二：在控制台直接删（更直观，适合一次处理一个项目）
delete from qc_records where project_id = '项目UUID';
delete from qc_projects where id = '项目UUID';
```

查询项目列表与 UUID：

```sql
select p.id, p.name, count(r.id) as 记录数
  from qc_projects p left join qc_records r on r.project_id = p.id
 group by p.id, p.name order by p.name;
```

> 安全提示：`qc_admin_cleanup` 必须**同时**给出正确访问码与确认串 `CONFIRM_DELETE`；按项目清理时单次上限 200 条，防止误操作清库。

### 防范孤儿数据的实践建议

1. **同一台设备、同一浏览器**持续使用；不要频繁使用无痕模式
2. 重要记录定期用工具的「导出全部」备份一份 JSON
3. 成员离职前，请其**在自己电脑上**删除自己提交的记录（他本人能删，别人不能）
4. 项目周期结束后若需归档，改为在控制台导数（`qc_records_flat` 视图）后清理

### 数据量与免费额度

- 一条记录约 2~4 KB；5000 条约 15 MB，远低于免费层 500 MB
- 免费层项目**连续 7 天无访问会被暂停**，登录控制台点一下即可恢复，**数据不会丢**
- 定期用「导出全部」做离线备份是最稳妥的做法

---

## 常见问题

**Q：测试连接报 `ACCESS_DENIED`**
访问码不对，或 SQL 里的哈希没换成你访问码的哈希。执行 `select public.qc_check_access('你的访问码');` 确认返回 `true`。

**Q：报 `NO_SESSION` 或提示未取得会话**
第三步的匿名登录没打开。打开后刷新页面重试。

**Q：报 `function public.qc_fetch_all(text) does not exist`**
`schema.sql` 没执行成功。回到 SQL Editor 重新完整执行一遍。

**Q：报 `NOT_OWNER`**
该周期的记录是别人提交的。你只能修订自己提交的记录。换个周期名，或联系提交者。

**Q：不想用了，怎么退回纯本地模式？**
设置里点「断开云端」即可，本机数据不受影响，之后照常本地保存。

**Q：多人同时提交会不会冲突？**
不会。同一项目同一周期只保留一条记录（数据库唯一索引保证），重复提交视为修订，且仅本人可修订。

**Q：报 `function digest(text, unknown) does not exist`（42883）**
Supabase 把 `pgcrypto` 扩展装在 `extensions` schema，函数里必须把 `extensions` 加进 `search_path`。
当前 `schema.sql` 已修正；若你是早期版本，执行 `supabase/fix-access-fn.sql` 即可。

**Q：报 `column t.name does not exist`（42703）**
早期版本 `qc_fetch_all` 的字段引用错误。执行 `supabase/fix2-functions.sql` 修复。

**Q：报 `NOT_OWNER`，但这个记录明明是我提交的**
说明该周期的记录是**你上一次的浏览器会话**提交的（例如换过设备、清过浏览器数据）。
当前会话无法修订它，需要按上文「孤儿数据」的办法在控制台处理。

**Q：`.sql` 文件用记事本打开中文乱码**
用带 BOM 的副本：`supabase/schema-粘贴用.txt`。
