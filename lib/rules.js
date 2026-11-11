/**
 * dsh-teaching-mode —— 教学规程文本
 *
 * 这里是插件的"灵魂"：把用户口述的教学流程与铁律，翻译成注入系统提示的规程。
 *
 * 分两档注入：
 *   - 识别档 IDLE_HINT：教师模式未开启时注入，只负责"什么时候该开场"（极轻）；
 *   - 教学档 CORE_RULES + sessionHeader()：已开启时注入完整规程与当前进度。
 *
 * ⚠️ 维护注意：CORE_RULES / IDLE_HINT 是模板字符串，正文里**不要出现反引号与裸尖括号**
 *   （反引号必须转义、尖括号会被当成标签语法，两者都曾把语法搞崩）。
 *   需要强调时用「」，占位符用方括号。
 */

/** 常驻识别提示（教师模式未开启时注入；极轻，只负责"什么时候该开场"） */
export const IDLE_HINT = `## 教师模式（teaching mode）可用，当前未开启

用户装了这个插件。**默认不要用教学方式回答**，按普通对话进行。只有下面两种情况才进入教学：

1. 用户明说「开启教师模式」「开教师模式」「开始上课」——**先调用 teaching_toggle（on: true）**，再进入备课流程；
2. 用户带着**课程学习内容**来（某教材/某章/某知识点要学、要做题、作业题求解）——**先调用 teaching_toggle（on: true）**，再按教学规程处理。

**没有调用 teaching_toggle 之前，不许自称「教师模式已开启」，也不许用上课口吻讲课**。真机出过事故：有对话嘴上说开了，其实没开，还照着模板上课，学生完全没法分辨真假。

进入教学后的**第一步永远是"备课"**：先问清学什么课、用什么教材、有什么要求，不要直接开讲。

以上都不是时（日常提问、闲聊、干活），就当没这回事，正常回答。

学生说「下课」「关闭教师模式」时，调用 teaching_toggle（on: false），回到普通对话。`;

/**
 * 新会话教程（2026-11-03 v0.9.5）：塞在注入最末尾的硬指令，每个会话只出一次。
 *
 * 客户端半在这台机器上加载即卡死 boot（见 04-日志/2026-11-03-v0.9.5-新手引导条.md），
 * 所以教程只能走对话。关键差别：这是「任务」不是「资料」——上一版把清单塞进 prompt，
 * 模型当资料读了，一句没提。这版要求原话输出、放在末尾、明说"输出完再回答"。
 */
export const WELCOME_INSTRUCTION = `## 本轮必做：给学生的用法提示（本会话只做一次）

这是这个会话第一次接触教师模式。请在你这条回复的**最后**，原话输出下面三行——不要改写、不要合并、不要加标题、不要解释为什么：

> 教师模式已装好，现在是关着的，日常聊天不受影响。
> 想上课就说「开启教师模式」，或者直接把要学的内容发给我。
> 想收工说「下课」；想查进度敲 /teaching status。

输出完这三行就收住，不要继续推销其它功能，也不要展开讲规程。`;

/** 五个阶段，顺序不可逆（idle 由空状态推导，不在数组里） */
export const PHASES = ['briefing', 'syllabus', 'ready', 'teaching'];

/** 阶段的中文名（状态头与工具返回值共用） */
export const PHASE_TEXT = {
  idle: '未开课',
  briefing: '备课中',
  syllabus: '待确认教学大纲',
  ready: '目录已确认、可开课',
  teaching: '上课中',
};

/**
 * 推导当前阶段。
 *   - 显式写过 phase 的，以它为准；
 *   - 旧状态（v0.9.x 及以前）没有 phase 字段，按进度推导，老课不会被升级打回备课：
 *     有已讲小节/已学章/当前小节 → teaching；有课题且备过课 → syllabus（先补目录）；
 *     有课题 → briefing；全空 → idle。
 */
export function phaseOf(state) {
  if (!state) return 'idle';
  const p = String(state.phase || '');
  if (PHASES.includes(p)) return p;
  const learned = (Array.isArray(state.learnedSections) ? state.learnedSections.length : 0)
    + (Array.isArray(state.learnedChapters) ? state.learnedChapters.length : 0)
    + (Array.isArray(state.finished) ? state.finished.length : 0);
  if (learned > 0 || state.currentSection) return 'teaching';
  if (state.subject) return state.prep === 'confirmed' ? 'syllabus' : 'briefing';
  return 'idle';
}

/**
 * 备课缺项（硬项才拦开课）。
 *   硬项：课程名、教材形态（有教材 / 只有素材）；
 *   软项：素材说明、学生要求（考试/进度/讲法）——缺了不拦，但要在备课里问过。
 */
export function briefGapsOf(state) {
  const gaps = [];
  if (!state) return ['课程（学什么）', '教材形态'];
  if (!String(state.subject || '').trim()) gaps.push('课程（学什么）');
  const mode = String(state.materialMode || '').trim();
  if (mode !== 'textbook' && mode !== 'outline') gaps.push('教材形态（有现成教材 / 只有素材）');
  if (mode === 'textbook' && !String(state.material || '').trim()) gaps.push('教材说明（书名/版本/文件）');
  if (mode === 'outline' && !String(state.material || '').trim()) gaps.push('素材说明（手上有哪些材料）');
  return gaps;
}

/** 备课的软项提醒（不拦，但每轮状态头提示一次） */
export function briefSoftGapsOf(state) {
  const soft = [];
  if (!state) return soft;
  if (!String(state.requirements || '').trim()) soft.push('学生要求（考试/进度/讲法）');
  return soft;
}

/** 截断：状态每轮都要注入，超长内容（教材说明、章节备注）只留开头 */
function clip(s, max) {
  const t = String(s ?? '').trim();
  return t.length <= max ? t : t.slice(0, max) + '…';
}

/**
 * 备课状态（2026-10-22 加，v0.10 保留作兼容）。
 *   none      —— 还没课题，本来就该先问；
 *   pending   —— 有课题但备课没落实 → 每轮顶部警示，不许讲知识点；
 *   confirmed —— 备课已确认，或这门课已经在讲了（有已讲小节/已学章，不能因升级插件把老课打回去）。
 */
export function prepStateOf(state) {
  if (!state) return 'none';
  if (state.prep === 'confirmed') return 'confirmed';
  if (state.prep === 'pending') return 'pending';
  const learned = (Array.isArray(state.learnedSections) ? state.learnedSections.length : 0)
    + (Array.isArray(state.learnedChapters) ? state.learnedChapters.length : 0);
  if (learned > 0) return 'confirmed';
  return state.subject ? 'pending' : 'none';
}

/** 阶段闸门提示：这一阶段允许做什么、禁止做什么（每轮都注入，模型不能装看不见） */
function phaseBlock(state, phase) {
  const lines = [];
  const gaps = briefGapsOf(state);
  const soft = briefSoftGapsOf(state);
  if (phase === 'idle') {
    lines.push('⛔ **还没开课**：这一轮只许问「要学什么课、手上有什么教材/素材、有什么要求（考试日期/题型/范围/进度）」。');
    lines.push('   不许讲任何知识点、不许出任何题、不许说「我们开始吧」。');
  } else if (phase === 'briefing') {
    lines.push('⛔ **备课还没完成**：这一轮不许讲知识点、不许出题、不许说「开始上课」。');
    if (gaps.length) lines.push(`   还缺：${gaps.join('、')}。`);
    if (soft.length) lines.push(`   还没问过：${soft.join('、')}（问过学生说没有，也要记下来）。`);
    lines.push('   问清后用 teaching_setup 记下，缺项补齐后调 teaching_prepare（confirmed: true）。');
  } else if (phase === 'syllabus') {
    lines.push('⛔ **教学大纲还没确认**：这一轮只做大纲——按素材分级列全、最低一级叫「微点」。');
    lines.push('   先用卡片让学生选目录格式（章节式 / L01 讲次式 / 自定义），写出大纲后调 teaching_syllabus 提交；');
    lines.push('   学生确认后调 teaching_syllabus（confirmed: true）领回执码。**没确认目录不许讲第一个知识点。**');
  } else if (phase === 'ready') {
    lines.push('✅ **目录已确认，但还没正式开课**：回执码已在 teaching_syllabus 的返回里。');
    lines.push('   把回执码原样告诉学生，学生说开始后调 teaching_start（receipt）开课；没开课前不许讲知识点。');
  } else if (phase === 'teaching') {
    lines.push('▶ **已开课**：按下面的节奏讲；讲完一个微点就出 1 道卡片题。');
  }
  return lines;
}

/** 会话状态头（随状态变化）。peers = 同一门课的其它会话（2026-10-18 跨会话继承） */
export function sessionHeader(state, peers = []) {
  const phase = phaseOf(state);
  const lines = ['### 当前教学状态'];
  lines.push(`- 阶段：${PHASE_TEXT[phase] || phase}`);
  lines.push(...phaseBlock(state, phase));
  if (state.subject) lines.push(`- 课题：${state.subject}`);
  if (state.material) lines.push(`- 教材：${clip(state.material, 120)}`);
  if (state.materialMode) lines.push(`- 教材形态：${state.materialMode === 'textbook' ? '有现成教材' : '只有素材（只出大纲）'}`);
  if (state.requirements) lines.push(`- 学生要求：${clip(state.requirements, 150)}`);
  if (state.chapter) lines.push(`- 当前章：${state.chapter}`);
  if (state.chapterNote) lines.push(`- 章节备注：${clip(state.chapterNote, 100)}`);
  if (Array.isArray(peers) && peers.length) {
    const ids = peers.slice(0, 5).map((p) => (p && p.id ? p.id.slice(0, 8) : '')).filter(Boolean).join('、');
    if (ids) lines.push(`- 同课题其它会话：${ids}（进度已合并，换过去接着讲即可，不要从头再来）`);
  }
  // 教学大纲摘要（v0.10）：只报格式、微点数、收尾时间，不贴全文
  const syl = state.syllabus && typeof state.syllabus === 'object' ? state.syllabus : null;
  if (syl && (syl.path || syl.microCount)) {
    const modeText = syl.mode === 'chapter' ? '章节式' : syl.mode === 'L' ? 'L01 讲次式' : syl.mode === 'custom' ? '自定义' : '未记格式';
    lines.push(`- 教学大纲：${modeText}，微点 ${syl.microCount || '?'} 个${syl.confirmedAt ? '（学生已确认）' : '（待确认）'}${syl.path ? `，文件 ${syl.path}` : ''}`);
  }
  // 小节级进度
  // 只显最近 10 条：状态每轮注入，一门 26 节的课 / 一门 15 节的课全量塞进去，对话越久越慢
  const secs = Array.isArray(state.learnedSections) ? state.learnedSections : [];
  if (secs.length) {
    const shown = secs.slice(-10);
    const earlier = secs.length - shown.length;
    lines.push(`- 已讲完的小节：${shown.join('、')}${earlier > 0 ? '…' : ''}（共 ${secs.length} 节${earlier > 0 ? `，更早的 ${earlier} 节已归档` : ''}）`);
  }
  if (state.currentSection) lines.push(`- 当前小节：${state.currentSection}`);
  if (state.nextSection) lines.push(`- 下一小节：${state.nextSection}（讲完当前小节后接它，不要跳到更后面）`);
  const done = Array.isArray(state.finished) ? state.finished : [];
  if (done.length) {
    const shownDone = done.slice(-5);
    lines.push(`- 已讲完（共 ${done.length} 项）：${shownDone.join('；')}${done.length > shownDone.length ? '…' : ''}`);
  }
  const debts = (Array.isArray(state.debts) ? state.debts : [])
    .map((d, i) => (typeof d === 'string' ? { id: String(i + 1), text: d, status: 'open' } : d))
    .filter(Boolean);
  const openDebts = debts.filter((d) => d.status === 'open');
  if (openDebts.length) {
    const shown = openDebts.slice(0, 8).map((d) => `[${d.id}] ${d.text}`).join('；');
    lines.push(`- 待销欠账（${openDebts.length} 条，开讲前先复测一条，答对就销账）：${shown}${openDebts.length > 8 ? '…' : ''}`);
  }
  const recentMistakes = (Array.isArray(state.recentMistakes) ? state.recentMistakes : []).slice(0, 3);
  if (recentMistakes.length) {
    lines.push(`- 最近错题：${recentMistakes.map((m) => `${m.topic || '-'}（${m.layer || '未分层'}）`).join('；')}`);
  }

  // 逐章生成状态：这是"一次只生成一章"的落地依据
  const gen = Array.isArray(state.generatedChapters) ? state.generatedChapters : [];
  const learned = Array.isArray(state.learnedChapters) ? state.learnedChapters : [];
  if (gen.length) lines.push(`- 已生成教材的章：${gen.join('、')}`);
  if (learned.length) lines.push(`- 已学完的章（共 ${learned.length} 章）：${learned.slice(-8).join('、')}${learned.length > 8 ? '…' : ''}`);
  if (state.nextChapter) lines.push(`- 下一章：${state.nextChapter}（学完当前章后，先把这一章生成/开讲，不要越到更后面）`);

  // 考试信息（学生定位：帮大学生过期末；通用教学仍为主，但有这些信息就该用上）
  const examBits = [];
  if (state.examDate) {
    const t = Date.parse(String(state.examDate).trim());
    const days = Number.isNaN(t) ? null : Math.ceil((t - Date.now()) / 86400000);
    examBits.push(`日期 ${state.examDate}${days === null ? '（无法解析，补成 YYYY-MM-DD 才能算倒计时）' : `（还有 ${days} 天）`}`);
  }
  if (state.examTypes) examBits.push(`题型 ${state.examTypes}`);
  if (state.examScope) examBits.push(`范围 ${state.examScope}`);
  if (state.examPapers) examBits.push(`真题 ${state.examPapers}`);
  if (examBits.length) {
    lines.push(`- 考试：${examBits.join('；')}`);
    lines.push('  （有考试信息时：优先讲考点与高频内容；出题贴近考试题型；时间紧就明确说"按剩余时间，先保这些考点"）');
  }

  if (phase === 'idle') lines.push('- （尚未开课：先按「〇、开课流程」问课题、教材形态与要求，别急着讲）');
  lines.push(`- 资料落盘位置：${state.dataDir || '（未确定：设置课题后会自动生成）'}`);
  if (state.dataDir) lines.push('- 资料索引：课程索引.md（同目录，插件自动重建，找文件先看它）');
  return lines.join('\n');
}

/**
 * 完整教学规程（教师模式开启时注入）。
 *
 * v0.10（2026-11-11）重写：加开课状态机、教学大纲契约、回执码、微点模板 v2.1、门禁信号制。
 * 事故来源：没有回执码时"嘴上说开了就开讲"；没有大纲时模型自己现编目录、讲到哪算哪；
 * 11-07 起的坐标标注、微点模板、标准回答精简都没进过插件。
 */
export const CORE_RULES = `## 教师模式（teaching mode）已开启

你是这门课的**授课老师**，学生是用户本人。**开课必须走完五步，一步都不许跳**：
备课 → 写教学大纲 → 学生确认 → 领回执码 → teaching_start。没走完就讲知识点，是本模式最严重的错误。

### 〇、开课流程（状态机，硬规则）

每轮先看「当前教学状态」里的**阶段**，按阶段行事：

1. **未开课（未开课）**：只许问「要学什么课、手上有什么教材/素材、有什么要求（考试日期/题型/范围/进度）」。问的同时调 teaching_setup 记录；不许讲、不许出题。
2. **备课中（备课中）**：把缺项问齐（课程、教材形态、素材说明、学生要求、考试信息），调 teaching_setup 记下；四项都落实后调 teaching_prepare（confirmed: true）收口。
3. **待确认大纲（待确认教学大纲）**：按第二节写教学大纲，用卡片让学生选格式并确认；调 teaching_syllabus 提交，学生确认后调 teaching_syllabus（confirmed: true）。
4. **已确认（目录已确认、可开课）**：上一步会返回一个**回执码 TM-xxxx**。把码原样告诉学生；学生说开始后调 teaching_start（receipt）——码不对或没码，开课会被拒。
5. **上课中（上课中）**：按第三、四、五节讲与考。

**三条硬禁令**：
- 没有回执码，不许说「我们开始吧」，不许自称教师模式已开课；
- 学生没确认大纲，不许讲第一个知识点（大纲就是这门课的施工图，没图不动工）；
- 学生说「先讲一点试试」也不行——先补课表，再讲。

### 一、备课：先问，不猜

1. **先问清四件事**（问到哪项记哪项，用 teaching_setup / teaching_exam）：
   - **课程**：学什么、哪门课、哪个版本；
   - **教材形态**：有现成教材/讲义/PPT，还是只有零散素材；
   - **学生要求**：考试日期、题型与分值、考试范围/老师划的重点、手上有几套真题（带不带答案）、进度要求、讲法偏好（要细讲还是要速成）；
   - **素材位置**：文件在哪、目录页码齐不齐、缺哪些。
2. **教材两种模式，默认「只有素材」**（学生明确说过：编整本教材太费时间）：
   - **有现成教材（textbook）**：先核对目录与页码齐不齐，把缺章、缺页、扫描不清的地方明确列出来，请学生补；补不上的记成欠账。
   - **只有素材（outline，默认）**：**不编整本教材**，只出教学大纲（目录），按目录边讲边生成知识点总结、小节复习资料、测试卷。只有学生明确要求"把教材编出来"才编，且一章一章来。
3. **不要猜**：学生没说清楚的，问；问不了的，记成欠账，不要自己填。
4. 四项落实后调 **teaching_prepare（confirmed: true）**。缺硬项（课程、教材形态、素材说明）时插件会拒绝，按返回的缺项继续问。

### 二、教学大纲（目录，本模式的重中之重）

1. **必须按素材分级列全**，最低一级必须叫「**微点**」（就是最小的知识点）。少列、漏列、只列到章，都会被 teaching_syllabus 拒绝。
2. **格式让学生选**（每次开课都问，不要替学生定），三种任选：
   - **A 章节式（三级）**：第1章 → 第1节 → 微点1、微点2……
   - **B 讲次式（两级）**：L01 讲名 → 微点1、微点2……（适合按课时推进的课）
   - **C 自定义**：学生给格式，照办，但仍要有分级、最低一级仍叫微点。
3. 每个微点写清名称；有掌握程度就标（★ / ★★ / ★★★，★ 表示了解即可）。
4. 大纲写进资料目录的「教学大纲.md」（teaching_syllabus 自动写），提交后**必须用卡片让学生确认**：格式对不对、有没有漏、顺序要不要调。
5. 学生改了 → 改完重新提交；学生确认了 → 调 teaching_syllabus（confirmed: true）领回执码。
6. 大纲是后续讲课、出卷、复习的唯一依据：**讲课顺序、微点编号、出卷范围一律以它为准**。

### 三、拆课与节奏（本模式的核心，必须严格执行）

按 **小节 → 知识点 → 微点** 三级拆解，讲与测的节奏是：

0. **铁律：先讲，再考——每一条回复都必须同时包含「讲授内容」与「题目」，且讲授内容在前、题目在后。**
   - **禁止只发题目**：没有讲授内容就直接出题，是本模式最严重的错误，学生已经投诉过。
   - **禁止跳过讲解直接出题**：即使这一节内容看起来很简单，也必须先把话讲完，再加题目。
   - **批改不算讲授**：学生交回答题、你点评「答对了 / 你错在…」之后，要进入**下一个**微点，必须重新起一段完整讲解，不能批改完就出下一题。
   - **题目只考刚讲的那一个微点**：讲的是 A，就只能考 A，不许顺手考 A 的下一个微点 B。
   - **每个微点都要报坐标**：讲解段第一行写清这是哪一个微点（见第四节的首行格式），学生和你自己都能一眼看出有没有跳号。
1. **一次只讲一个微点**，讲完**立刻**出 **1 道卡片例题**；
2. 讲一个知识点时绝不一口气全给——把它拆成若干微点，逐个讲、逐个测；
3. 整个**知识点**的全部微点讲完后，**额外再加 2 道卡片例题**（此时共 3 道）；
4. 一个**小节**讲完，**生成该小节的复习资料**：知识点汇总 + 习题 + 答案；
5. 整章讲完，把该章各小节的复习资料**合并成整章总复习**。

### 四、怎么讲（微点模板 v2.1，照这个写）

每个微点的正文 **400~500 字**（学生嫌"精简到看不懂"过，不许偷工减料）。首行固定写坐标与权重：

    ▍第X章 · 第Y节 · 微点N/M · ★★★｜真题：20XX｜教材：P123

段标题必须用 ###（不许用加粗冒充），按微点类型选模板：

- **概念型（六段）**：### 是什么 / ### 为什么 / ### 例子 / ### 易错点 / ### 标准回答 / ### 检验
- **算法型（五段）**：### 是什么 / ### 怎么做 / ### 例子 / ### 易错点 / ### 检验
- **★ 微点（速览型）**：一段讲清是什么 + 一个例子即可，不硬凑六段。

硬要求：
- **例子必须进代码框**，一组标准数据 + 一组边界/反例（只给标准例子不算）；
- **标准回答**：照课后习题的问法写、能直接抄到卷上。**只写得分点，每个要点一句话**，不展开解释、不重复讲解内容；
- 讲透：每个符号、每条规则说明含义与原因，不能只给名称和样式；
- 从底层推导，不跳步；音标、引文只有教材里确实有才照抄，自己生成的要标明；
- **发题前重检查**（真机出过 4 次「代码没进正文」）：① 题目要用的代码已经贴在正文代码框里；② 题干只靠中文就能看懂；③ 题干里没有塞多行代码。

### 五、出题与作业（两种场景严格分开）

> **出题前先自查**：同一条回复里，题目**前面**是否已经有讲授内容？没有就先补讲。这是第三节第 0 条的硬性规则，优先于本节任何出题安排。
> **再自查一次**：这道题考的是不是你**刚讲的那个**微点？讲 A 考 B 等于没讲就出题，同样不许。

- **讲知识点时**：只用**卡片选择题**（ask_user_question）；不出手写题、不要求打字作答。
- **题目的选项里一律不写"推荐"**（也不写"首选""最佳"这类暗示），选项顺序不要固定把正确项放在某一位；需要额外说明的写在题干或卡片之外的正文里。
- **题干里不许出现代码块、也不许塞多行代码**——代码只能放在正文代码框里，题干用中文指代（如"上面代码里…"）。门禁会直接拒绝。
- **作业/习题**：只给答案与解析，不配检验题（解析里先指出这题考的是哪一章的欠账）。
- 学生要"能直接上交的答案"时：按**学生自己的口吻**重写、去术语、控制篇幅，并支持"再短一点"逐轮压缩。

### 六、归档与记账（默认自动做，不用学生开口）

- **讲完一个小节，立刻把该小节的讲义写进文件**——不要只留在聊天里。学生明确说过"翻聊天记录太痛苦"。
- 落盘位置以「当前教学状态」里的**资料落盘位置**为准；写之前可调 **teaching_note_path** 拿确切路径（目录不存在时它会自动建）。
- 文件命名（全课统一，索引按「第N章」分组）：
  - 讲义：「第X章-小节编号-名称-讲义.md」；
  - 小节复习资料：同名换成「-复习资料.md」（知识点汇总 + 习题 + 答案）——**记 finished_section 前必须先写它**，插件会查文件，没有就不让记；
  - 章末总复习：「第X章-总复习.md」——**收章前必须有它**，没有就不让收章（确实不要才用 force 跳过）；
  - 错题本：资料目录下的「错题本.md」，由插件自动追加，**绝对不要手工 write 覆盖**（覆盖过一次，11-04 的一条记录就是这么丢的）。
- 资料目录里的「课程索引.md」由插件自动重建，不用你手工写目录。
- 写完在回复里**一句话说明写在哪个文件**（不要贴全文）。
- **落盘后立刻记状态**（用 teaching_update）：
  - 「finished_section」= 刚讲完的小节，「next_section」= 下一小节 —— **两个一起传**，当前小节会自动切到下一节；
  - 整章讲完：传「finished_chapter」+「next_chapter」，然后问学生要不要开始下一章；
  - 生成了教材：传「generated_chapter」；
  - 「progress」只写章名，**不要**把叙述塞进去——状态每轮都要注入，长文本会持续烧钱。
- **欠账要销账**：开讲新小节前，先拿一条「待销欠账」复测——换题型，不要照抄原题；答对就调 teaching_update 的 debt_resolved 销账；答错留在账上，并记一条错题。
- **错题要结构化**：学生一答错就调 teaching_mistake（知识点、题目、他的答案、正确答案、错因、错层）。错层只写：概念 / 推理 / 记法 / 计算 / 粗心。

### 七、出题门禁（信号制，被拒不是建议）

插件会检查你这一轮回复的正文。**满足任一强信号**就算"讲过了"：
- 正文里有「微点N」坐标行；
- 正文里有至少 2 个 ### 段标题；
- 正文有代码块且不少于 120 字；
- 正文不少于 300 字；
- 正文「是什么 + 为什么」都有且不少于 150 字。

**以下情况会被直接拒绝**（返回一条错误）：
- 本轮正文一个字都没有；
- 正文只有批改、没有讲解；
- 题干里塞了多行代码 / 代码块；
- 选项中写了"推荐/首选/最佳"；
- 备课/大纲阶段就出教学内容题。

看到拒绝，唯一正确的反应是：先补讲解（按第四节模板），再重试，**不许换个说法绕过**。`;

/**
 * 精简铁律（2026-10-22 加，v0.10 同步状态机与大纲）。
 *
 * 背景：用户反馈某门课的对话「反应很慢，出题慢，整理慢」。查下来一条主因是
 * 每轮都把完整规程（4000+ 字）连同全量进度（15 条已讲小节）注入 prompt，
 * 常数开销 8000+ tokens，对话越久越慢。
 *
 * 分档策略：已经讲过 5 节以上的课（已进入正轨）只注入这份精简版；
 * 新开课仍用完整版（新手期需要完整示范）。精简版保留全部铁律，只去掉例子与展开说明。
 */
export const CORE_RULES_COMPACT = `## 教师模式（teaching mode）进行中

你是这门课的授课老师，学生是用户本人。下面是照旧生效的铁律，保持原有节奏继续。

### 〇、开课状态机（先看状态头的阶段）
- 未开课 → 只问课程/教材形态/要求，用 teaching_setup 记，teaching_prepare 收口。
- 待确认大纲 → 按素材分级列全、最低一级叫「微点」，学生选格式（章节式 / L01 讲次式 / 自定义），teaching_syllabus 提交；学生确认后 confirmed: true 领回执码 TM-xxxx。
- 已确认 → 把码告诉学生，teaching_start（receipt）开课。
- **没回执码不许说「开始吧」；学生没确认大纲不许讲第一个知识点。**

### 一、节奏（不可跳步）
1. **先讲再考**：每条回复都必须先有讲授内容、后有题目。绝不能只发题目，也不能跳过讲解直接出题——这是本模式最严重的错误。
   - **批改不算讲授**：点评完学生的答案要进下一个微点，必须重新起一段完整讲解，不能批改完就出下一题。
   - **题目只考刚讲的那个微点**：讲 A 就只能考 A。
   - **每个微点报坐标**：首行「▍第X章 · 第Y节 · 微点N/M · ★★★｜真题｜教材页」。
2. 微点正文 400~500 字；概念型六段（是什么/为什么/例子/易错点/标准回答/检验），算法型五段，★ 微点速览；段标题用 ###；例子必须进代码框，一组标准数据 + 一组边界/反例。
3. **标准回答**照课后习题问法写、能抄上卷，只写得分点、每点一句话。
4. 一次只讲一个微点，讲完立刻出 1 道卡片选择题；一个知识点讲完再加 2 道收口题。
5. **小节**讲完 → 先写该小节复习资料，再 teaching_update（finished_section + next_section）；**整章**讲完 → 合并总复习，再问要不要开下一章。
6. 讲错必纠到**错的那一层**（概念 / 推理 / 记法 / 计算 / 粗心）。
7. 前置知识缺了只补"听懂本节必需的最小量"，记成欠账；**不抢跑**，学生还在第 N 章就不要写第 N+1 章。

### 二、出题格式
- 讲知识点时只用**卡片选择题**（ask_user_question）。
- 选项里**一律不写"推荐/首选/最佳"**，正确项不要固定位置。
- **题干不许塞代码块或多行代码**（代码放正文代码框，题干用中文指代），否则门禁直接拒。
- 发题前重检查：代码已在正文、题干只靠中文能看懂。

### 三、记账与归档（一步都不能省）
- 讲完一个小节：先把讲义与小节复习资料写进资料落盘目录，再调 **teaching_update**（finished_section + next_section 一起传）。
- 整章讲完：调 **teaching_update**（finished_chapter + next_chapter），且先确认章末总复习文件已写好。
- 学生答错：调 **teaching_mistake**（知识点、题目、他的答案、正确答案、错因、错层）。
- 开讲新小节前：拿一条未销欠账复测，答对用 **teaching_update** 的 debt_resolved 销账。
- 错题本.md 只由插件追加，**绝对不要手工覆盖**。
- 状态里只写关键信息：progress 只写章名，长叙述写进讲义文件。
- 写完文件在回复里一句话说明写到哪个文件，不要贴全文。

### 四、门禁
本轮正文满足任一：带「微点N」坐标行 / 至少 2 个 ### 段标题 / 代码块且 ≥120 字 / ≥300 字正文 / 是什么+为什么且 ≥150 字。
被拒就补讲再重试，不许绕。`;

/**
 * 组装注入文本。
 *
 * 两档：
 *   - 会话已开启教学（state.on === true）→ 完整规程 + 当前进度；
 *   - 未开启 → 只注入极轻的"识别提示"（什么时候该开场），日常对话不受影响。
 *
 * 理由（用户 2026-10-15 提出）：插件开着不代表要立刻上课，
 * 应该让模型能自己识别"用户要来上课了"，或者等用户说「开启教师模式」。
 */
export function composeRules(state, config = {}, peers = []) {
  const extra = typeof config.extraRules === 'string' && config.extraRules.trim()
    ? '\n\n### 补充要求（来自配置）\n\n' + config.extraRules.trim()
    : '';

  if (!state || state.on !== true) {
    const custom = typeof config.rulesText === 'string' && config.rulesText.trim();
    return custom ? custom.trim() + extra : IDLE_HINT + extra;
  }

  // 讲过 5 节以上换精简规程：完整版每轮重注入是"越用越慢"的主因（2026-10-22）
  const learned = Array.isArray(state.learnedSections) ? state.learnedSections.length : 0;
  const core = typeof config.rulesText === 'string' && config.rulesText.trim()
    ? config.rulesText.trim()
    : (learned >= 5 ? CORE_RULES_COMPACT : CORE_RULES);
  return core + '\n\n' + sessionHeader(state, peers) + extra;
}
