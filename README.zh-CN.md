# dsh-teaching-mode · 教师模式

[![npm version](https://img.shields.io/npm/v/dsh-teaching-mode.svg)](https://www.npmjs.com/package/dsh-teaching-mode)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![tests](https://img.shields.io/badge/tests-224%20passing-brightgreen.svg)](#开发)
[![DeepSeek Harness](https://img.shields.io/badge/DeepSeek%20Harness-plugin-4B6BFB.svg)](https://github.com/deepseek-ai/deepseek-harness)

> 给 DeepSeek Harness 装一个"会按老师方式教"的开关：**一次一个小知识点 → 讲完立刻出题 → 知识点收口补题 → 小节出复习资料**。

- 装完默认**关闭**，不影响你平时的对话
- 要用时敲 `/teaching on`，不用时 `/teaching off`
- 状态按**会话**分开记，一个会话一门课，互不干扰

---

## 为什么做这个

长对话里让 AI 讲课，最常见的三个毛病：

1. **一口气倒完**——一个知识点几千字甩过来，看完什么也没记住；
2. **不测**——讲完就完了，不知道哪里没懂；
3. **不留痕**——内容全在聊天记录里，过两周想复习得往上翻半天。

这个插件把"讲—测—归档"的节奏固化成规程，注入每次模型请求，逼着 AI 按老师的节奏走。

## 教学流程（插件内置的规程）

### 一、备课：先问，不猜

1. 先确认**课题与教材**（书名/版本/章节/真题）
2. **有材料 → 先检查**：看**目录与页码齐不齐**，缺章缺页明确列出来请你补
3. **没材料 → 自己生成，但两步走**：
   - 第一步**只给大纲**（章 → 节 → 知识点），等你确认
   - 第二步**只生成第一章**（不写第二章）；学完再问要不要下一章
   - 生成的正文必须标注"这是生成的，不是原书原文"

### 二、拆课：三级粒度（核心）

```
小节 8.5 数据有多长
 ├─ 知识点 A
 │   ├─ 小知识点 A1 ── 讲完 → 1 道卡片例题
 │   ├─ 小知识点 A2 ── 讲完 → 1 道卡片例题
 │   └─ 知识点 A 收口 ── 再加 2 道卡片例题
 └─ 知识点 B …… 同上
小节 8.5 讲完 → 生成「8.5 复习资料」（知识点 + 习题 + 答案）
整章讲完 → 合并成整章总复习
```

**关键铁律**：

- 一次只讲一个知识点，讲完立刻测
- 讲一个知识点时**不要一口气全给**，拆成小知识点逐个讲
- 每个小知识点讲完配 **1 道卡片例题**；整个知识点讲完**再加 2 道**
- 小节讲完**必须**生成复习资料

### 三、怎么讲

- **讲透**：每个符号、每条规则都要说明含义与原因，不能只给名称和样式
- 从底层推导、不跳步
- **自检**：标题写的条数必须与内容条数一致；归纳表格要注明"这是归纳，不是教材原文"
- **不抢跑**：以你带回的课堂进度为准；缺的前置知识只补"听懂本节必需的最小量"，记成欠账，撞到再补
- 答错要指出**错在哪一层**，不能只给正确答案

### 四、出题与作业（两种场景严格分开）

| 场景 | 做法 |
|---|---|
| 讲知识点 | 只用**卡片选择题**，不出手写题 |
| 作业/习题 | **只给答案与解析，不配检验题** |
| 要"能上交的答案" | 按学生口吻重写、去术语、控制篇幅，支持"再短一点" |

## 安装

已发布到 npm：**`dsh-teaching-mode`**（https://www.npmjs.com/package/dsh-teaching-mode）

```sh
npm install dsh-teaching-mode
```

桌面版的命令行**不允许管理 `desktop` profile**（归 App 管），所以要在应用里装：开一个 DSH 会话，让它调 `plugin_manager` → `install_bundle`，target 传 `dsh-teaching-mode`（包名，DSH 会从 npm 解析）。

想用本地源码装也可以：先把仓库克隆下来，再把 `install_bundle` 的 target 传 `file:<克隆目录的绝对路径>`。

```sh
git clone https://github.com/wbj19552259912-netizen/dsh-teaching-mode.git
```

装完重启 DSH（或让 profile 重新加载）。

## 界面

装好后有两处界面，都在 DSH 原生 UI 里：

| 位置 | 内容 |
|---|---|
| **设置 → 教学** | 插件简介、开关（新会话默认开启）、教学流程、铁律、命令用法 |
| **对话区「教学」页签** | 与「思维链」「请求上下文」并排，随手可查流程与铁律 |

> 设置里的开关是**本机偏好**（浏览器本地保存），表示"新会话想不想默认开课"；具体某个会话的即时开关仍用 `/teaching on` / `/teaching off`。

## 讲义自动落盘

**不需要你开口**——讲完一个小节，讲义与复习资料会自动写进文件：

| 内容 | 文件名 |
|---|---|
| 小节讲义 | `第X章-小节名-讲义.md` |
| 小节复习资料 | `第X章-小节名-复习资料.md`（知识点汇总 + 习题 + 答案） |
| 章末总复习 | `第X章-总复习.md` |
| 错题本 | `错题本.md`（每条含"错在哪一层"） |

**落在哪**：`<本对话的工作目录>/projects/<课题>/03-产出/` —— 也就是**该对话自己的文件夹**里，不会散在聊天记录中。

目录怎么来的：插件从会话头读到本对话的工作目录（`Session.header.cwd`），配合你设置的课题自动算出；用 `/teaching setup <课题> | <教材>` 设置课题后即可生成，`/teaching status` 里能看到当前落盘目录。

## 定位

**给想系统学一门课的人用的**——尤其是备考期末的大学生。

现有 AI 教学的常态是"给你一份讲义，你自己读"；这个插件要做的是**像老师一样带着你一点一点学**：讲一小块、立刻测一道、错了指出错在哪一层、学完一节出复习资料。

它也**支持考试驱动**：把考试日期、题型分值、考试范围、手上真题记进状态（`/teaching exam`），AI 就会优先讲考点、出题贴近你们卷子的题型，并在注入里看到倒计时。但这不是必须的——不考试也能用，只是少了这层针对性。

## 跨会话接力（v0.9.3）

一门课常常跨好几个对话：上下文一长就得换新会话。插件因此**不按会话认课，而按"这是哪门课"认**：

- 课题名先归一化：`初中英语（牛津译林版七年级下册）` 与 `初中英语（牛津译林版七年级）` 算同一门课
- 新会话如果把课题名写得和已有资料目录不一致，`teaching_setup` 会**自动沿用**已存在的 `projects/<课题>/03-产出`（不再派生一个空目录），并在回复里明说
- 同一门课的多个会话，每次插件启动都会**并账**（进度、已讲小节、欠账、错题）
- 教师模式还开着的新会话，注入里会看到一段「本工作区已有的课」线索（课题 / 进度 / 已讲几节 / 几笔欠账），知道该接力而不是从零开课
- `/teaching courses` 列课，`/teaching link <会话号前8位>` 手动把某门的进度挂到当前会话

> 换会话继续学：直接说"继续学 XX"，模型会先 `teaching_setup` 再接着讲，不用你重述进度。

## 命令

| 命令 | 作用 |
|---|---|
| `/teaching on` | 开启教师模式（当前会话） |
| `/teaching off` | 关闭，恢复普通对话 |
| `/teaching status` | 查看课题、教材、进度、欠账 |
| `/teaching setup <课题> \| <教材>` | 设置课题与教材，如 `/teaching setup 汇编语言 \| 王爽《汇编语言》第四版` |
| `/teaching progress <当前进度>` | 更新进度，如 `/teaching progress 第8章 8.5 数据有多长` |
| `/teaching debt <欠账内容>` | 记一条欠账（撞到再补）；记完带编号 |
| `/teaching debts` | 列出未销欠账、已销/作废条数、错题总数 |
| `/teaching resolve <编号\|关键词> [\| 备注]` | 销账：学生复测答对后把这条欠账关掉 |
| `/teaching drop <编号\|关键词> [\| 原因]` | 作废一条欠账（记错了或不再需要） |
| `/teaching mistakes [条数]` | 看错题总数、分层统计与最近几条 |
| `/teaching review [主题]` | 拿未销欠账 + 最近错题生成"专项复习"数据块，让模型据此出题 |
| `/teaching done <已讲完内容>` | 记一条已完成 |
| `/teaching gen <章>` | 记录「这一章教材已生成」 |
| `/teaching learn <章>` | 记录「这一章已学完」，并提示可以继续下一章 |
| `/teaching next <章>` | 设置下一章（学完当前章后先只生成它） |
| `/teaching exam <日期> \| <题型分值> \| <范围> \| <真题>` | 记录考试信息，如 `/teaching exam 2026-12-31 \| 选择20+简答30+计算50 \| 第1-5章 \| 历年5套` |
| `/teaching index` | 重建资料目录的 `课程索引.md`（平时落盘会自动重建，这个用于手动补） |
| `/teaching finish-chapter <章> \| <下一章> [--force]` | 收章；目录里没有 `第X章-总复习.md` 会被拦下，`--force` 可跳过 |
| `/teaching section <小节>` | 设置当前小节 |
| `/teaching next-section <小节>` / `/teaching learn-section <小节>` | 设置 / 记录下一小节 |
| `/teaching finish-section <小节>` | 记一节已讲完 |
| `/teaching courses` | 列出状态库里所有课程及其会话（同课多会话合并显示） |
| `/teaching link <会话号前8位>` | 接力：把别的会话的课程字段（课题/目录/进度/欠账）复制到当前会话 |
| `/teaching repair` | 修状态：清掉陈旧的当前/下一小节、把过长章名拆成短名+备注 |
| `/teaching prune [-f]` | 清空壳会话记录（无课题无进度）；默认只预览，`-f` 才真删 |
| `/teaching reset` | 清空本会话的教学状态 |

## 模型工具（AI 自己调用，不用你敲命令）

| 工具 | 作用 |
|---|---|
| `teaching_setup` | 记课题与教材，自动算出资料落盘目录；换了课题会重新关上备课闸门 |
| `teaching_prepare` | **备课闸门**（v0.9.0）：教材目录/缺页、真题试卷、章节路线、考试信息四项落实后传 `confirmed: true`，之后才允许讲解 |
| `teaching_update` | 记进度 / 小节 / 章 / 欠账；`debt_resolved` 销账、`debt_dropped` 作废 |
| `teaching_exam` | 记考试日期、题型分值、范围、真题 |
| `teaching_mistake` | 记错题（含"错在哪一层"），明细自动追加到资料目录的 `错题本.md` |
| `teaching_note_path` | 查资料落盘目录 |

### v0.9.0 的两处行为变化

**1. 备课闸门（治"没备课就直接给知识点"）**

记了课题却还没落实教材整理 / 教学路线 / 试卷情况时，每轮注入的状态头最上面会挂一条拦截提示：

- 还没开讲：直接不许讲知识点、不许出题，只能把四项问清；
- 已经在讲了（有「当前小节」）：降一档提醒"这门课没备课就开讲了"，要求补齐备课，且补齐之前每轮只讲一个小知识点。

任一情况下讲过一节并把进度记账后，闸门自动放行（`prep` 转为已确认），不会长期骚扰。

**2. 规程分档（治"越用越慢"）**

讲过 5 节以上的课只注入**精简铁律**（约 1 千字），新开课仍用完整规程（约 4 千字）。
配合状态头限量显示（已讲小节只显最近 10 条、教材/备注截断），单轮注入从约 4800 字降到约 1700 字，每轮省下约 1900 tokens。
同时资料索引改为**文件清单没变就不重建**，避免每次工具调用都扫盘。

## 配置

**在 DSH 的设置里改**：设置 → 插件 → 插件配置 → `dsh-teaching-mode`（表单由插件 schema 自动生成，保存即生效）。

| 配置项 | 默认 | 说明 |
|---|---|---|
| `defaultOn` | `false` | **新会话默认开启教师模式**。勾上后新开的对话自动进入教师模式；你在某个对话里 `/teaching off` 关过之后，它不会被重新打开 |
| `statePath` | 空 | 状态文件路径；留空用 `$DSH_HOME/teaching-mode/state.json` |
| `rulesText` | 空 | 整体替换教学规程（高级用法） |
| `extraRules` | 空 | 追加到规程末尾的额外要求 |

也可以直接写 profile 的 `cordis.patch.yml`：

```yaml
- id: dsh-teaching-mode
  config:
    defaultOn: true
    extraRules: |
      出题后必须给出每个选项为什么对/错。
```

## 状态存在哪

默认 `$DSH_HOME/teaching-mode/state.json`，按会话 id 分桶：

```json
{
  "version": 1,
  "sessions": {
    "session-xxxx": {
      "on": true,
      "subject": "汇编语言",
      "material": "王爽《汇编语言》第四版",
      "chapter": "第8章 8.5 数据有多长",
      "finished": ["8.4 寻址方式总表"],
      "debts": ["第3章源程序结构"],
      "updatedAt": "2026-10-15T12:00:00.000Z"
    }
  }
}
```

想换位置就配 `statePath`，或用环境变量 `TEACHING_MODE_STATE`。

## 卸载

```sh
dsh plugin --profile desktop remove dsh-teaching-mode
```

插件是纯注入 + 状态文件，**卸载后不留任何钩子**；想连状态一起清掉，删掉 `$DSH_HOME/teaching-mode/` 即可。

## 开发者

```sh
node --check lib/index.js       # 语法
node tests/test.mjs             # 154 项契约测试（本地 mock Host，零费用）
node tests/client-test.mjs      # 25 项客户端测试
node tests/default-on-test.mjs  # 16 项默认开测试
node tests/rules-check.mjs      # 29 项规程检查
```

本仓库源码直接装在 `~/.dsh/profiles/desktop/node_modules/dsh-teaching-mode`（Junction 指向源码目录），改完代码**彻底重启** DSH 即生效，不必重新安装。

## 许可

MIT
