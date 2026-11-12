/**
 * dsh-teaching-mode v0.8.0 —— DSH 教师模式插件
 *
 * 一句话：把"一次一个小知识点 → 小知识点配 1 道卡片例题 → 知识点收口再加 2 道 → 小节出复习资料"的教学闭环，
 * 做成一个可开关的插件。开启后规程常驻注入，模型按老师的方式教；关闭后只注入极轻的识别提示。
 *
 * 用法（斜杠命令）：
 *   /teaching on | off | status
 *   /teaching setup <课题> | <教材>
 *   /teaching progress <当前章>
 *   /teaching debt <欠账内容>
 *   /teaching done <已讲完内容>
 *   /teaching section <当前小节>
 *   /teaching next-section <下一小节>
 *   /teaching learn-section <刚讲完的小节>
 *   /teaching finish-section <刚讲完的小节> | <下一小节>   ← 讲完一节用这个（自动推进）
 *   /teaching finish-chapter <整章讲完> | <下一章>          ← 整章学完用这个
 *   /teaching gen <已生成教材的章>
 *   /teaching learn <已学完的章>
 *   /teaching next <下一章>
 *   /teaching exam <日期> | <题型分值> | <范围> | <真题>
 *   /teaching repair            ← 一次性修脏数据
 *   /teaching prune [-f]        ← 清空壳会话记录（默认只预览）
 *   /teaching courses           ← 列出课程（跨会话合并视图）
 *   /teaching link <会话前 8 位>  ← 把本会话挂到别的会话的课程上
 *   /teaching reset
 *
 * 配置（设置 → 插件 → 插件配置，或 profile 的 cordis.patch.yml）：
 *   defaultOn   新会话默认开启教师模式（默认 false）
 *   statePath   状态文件路径（默认 $DSH_HOME/teaching-mode/state.json）
 *   rulesText   整体替换教学规程文本（高级用法）
 *   extraRules  追加到规程末尾的额外要求
 *
 * 设计原则：状态按"会话"存（互不干扰），同一门课跨会话自动合并；每个注册点单独兜底，
 * 任一注册失败都不拖垮插件；卸载无残留（状态文件留在磁盘，可手动删）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import {
  CORE_RULES, IDLE_HINT, WELCOME_INSTRUCTION, sessionHeader, composeRules, prepStateOf,
  phaseOf, briefGapsOf, PHASES, PHASE_TEXT,
} from './rules.js';

export const name = 'dsh-teaching-mode';

/** 可选注入：systemPrompt 是宿主总是提供的；commands / tools 有就用。 */
export const inject = ['systemPrompt'];

const require = createRequire(import.meta.url);

/** 插件版本（诊断日志里带版本号，方便确认"重启后到底加载的是哪一版"） */
const VERSION = '0.10.1';

/** 插件配置 schema。DSH 据此在设置里自动生成表单，并把改动写回 profile 的 cordis.patch.yml。
 *  schemastery 由宿主提供（peer），某些安装布局下可能解析不到；那时只退化为"没有设置表单"，绝不能让插件加载失败。 */
export const Config = (() => {
  try {
    const stub = process.env.TEACHING_MODE_SCHEMA_STUB;   // 测试用：指向 schemastery 的目录
    const req = createRequire(stub ? path.join(stub, 'noop.js') : import.meta.url);
    const mod = req('@deepseek-ai/schemastery');
    // 不同版本/桩的导出形态不同：z 命名导出、直接导出、或 default 导出
    const z = mod && mod.z && typeof mod.z.object === 'function'
      ? mod.z
      : (mod && typeof mod.object === 'function' ? mod : mod && mod.default);
    if (!z || typeof z.object !== 'function') return undefined;
    return z.object({
      defaultOn: z.boolean().default(false).description('新会话默认进入教学。关闭时插件仍会注入极轻的识别提示：你说「开启教师模式」或带着课程内容提问时才开场，平时不打扰。'),
      statePath: z.string().default('').description('状态文件路径（留空则用 $DSH_HOME/teaching-mode/state.json）'),
      rulesText: z.string().default('').description('整体替换教学规程文本（高级用法，留空用内置）'),
      extraRules: z.string().default('').description('追加到规程末尾的额外要求'),
    });
  } catch {
    return undefined;
  }
})();

/** 字段长度上限（2026-10-18 加）。
 *  真实教训：chapter 被模型塞进 150+ 字叙述、教材说明写成小作文——状态每轮都要注入，越长越贵，
 *  而且机器无法判断"这一章到底学完没"。超限选择报错而不是静默截断：截断会让模型以为记下了，其实丢了。 */
const LIMITS = {
  subject: 40,
  material: 200,
  chapter: 60,
  section: 60,
  list: 100,
  debt: 200,
  debtsMax: 50,
  debtsResolved: 50,
  requirements: 300,       // v0.10：学生要求（简短，状态每轮注入）
  syllabusText: 40000,     // v0.10：教学大纲全文上限（写文件，不进状态）
};

/** 新会话的空状态 */
function EMPTY_STATE() {
  return {
    on: false,
    subject: '',
    material: '',
    chapter: '',
    chapterNote: '',
    currentSection: '',
    nextSection: '',
    learnedSections: [],
    finished: [],
    debts: [],              // 欠账条目：{id, text, status: open|resolved|dropped, addedAt, resolvedAt, note}
    debtSeq: 0,             // 欠账编号自增
    recentMistakes: [],     // 最近错题摘要（明细写 <dataDir>/错题本.md，不塞进状态）
    mistakeStats: { total: 0, byLayer: {} },
    generatedChapters: [],
    learnedChapters: [],
    nextChapter: '',
    examDate: '',
    examTypes: '',
    examScope: '',
    examPapers: '',
    dataDir: '',
    cwd: '',
    prep: '',                // 备课闸门（2026-10-22 加）：'' 未评估 | 'pending' 待备课 | 'confirmed' 已完成
    // ── v0.10 开课状态机（2026-11-11）──
    phase: '',               // '' 未显式设置（按进度推导）| briefing | syllabus | ready | teaching
    materialMode: '',        // '' 未问过 | 'textbook' 有现成教材 | 'outline' 只有素材
    requirements: '',        // 学生要求（考试/进度/讲法），≤300 字
    syllabus: null,          // { mode, path, microCount, lineCount, confirmedAt }
    receipt: '',             // 开课回执码 TM-xxxx（学生确认大纲后生成）
    startedAt: '',           // 正式开课时间（teaching_start 通过时写入）
    updatedAt: '',
  };
}

/** 超限检查：通过返回 null，否则返回给人看的中文错误 */
function tooLong(label, value, max) {
  const s = String(value ?? '');
  if (s.length <= max) return null;
  return `「${label}」太长：${s.length} 字，上限 ${max} 字。状态每轮都要注入，请精简后重传（叙述写进讲义文件，状态里只留关键信息）。`;
}

/** 文件名安全化：去掉 Windows / POSIX 都不允许的字符 */
function safeName(s) {
  return String(s ?? '')
    .replace(/[\\/:*?"<>|]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 60);
}

/** 算出"该对话自己的"资料落盘目录：<会话工作目录>/projects/<课题>/03-产出 */
export function deriveDataDir(cwd, subject) {
  if (!cwd || !subject) return '';
  const safe = safeName(subject);
  if (!safe) return '';
  return path.join(cwd, 'projects', safe, '03-产出');
}

/** 落盘目录自检自愈（2026-10-16 加）。
 *  规则：目录存在 → 不动；重算相同 → 不动；重算不同且新路径确实存在 → 采用（被改名/挪走）；
 *  重算不同但新路径也不存在 → 保守不猜，保持原值。返回是否改动。 */
export function ensureDataDir(st, cwd) {
  if (!st || !st.subject) return false;
  const current = String(st.dataDir || '');
  if (current && fs.existsSync(current)) return false;
  const base = cwd || st.cwd || '';
  // 先按课题重算；重算出来的路径也不存在时，退一步在 projects/ 下找同一门课**已存在**的目录（接力自愈，2026-11-03）
  const recomputed = deriveDataDir(base, st.subject);
  const guess = suggestDataDir(base, st.subject);
  const pick = (recomputed && fs.existsSync(recomputed)) ? recomputed : (guess || '');
  if (!pick || pick === current) return false;
  st.dataDir = pick;
  return true;
}

/**
 * 接力自愈（2026-11-03）：模型接力上课时会把课题写成「高等数学（同济第七版上册）」，
 * deriveDataDir 于是算出一个根本不存在的目录，历史进度全落在旧目录里。
 * 这里在 <cwd>/projects 下按归一化课题找**已存在**的课目录，命中就沿用它的 03-产出。
 * 返回 '' 表示没有可沿用的候选。
 */
export function suggestDataDir(cwd, subject) {
  const want = normSubject(subject);
  if (!cwd || !want) return '';
  let names = [];
  try {
    names = fs.readdirSync(path.join(cwd, 'projects'), { withFileTypes: true })
      .filter((d) => d.isDirectory()).map((d) => d.name);
  } catch { return ''; }
  const hit = names.find((n) => normSubject(n) === want);
  if (!hit) return '';
  const dir = path.join(cwd, 'projects', hit, '03-产出');
  return fs.existsSync(dir) ? dir : '';
}

// ── 小节 / 章名判定 ──

/** 两个小节名是否指同一节（2026-10-18 加）。
 *  不能只比字符串：真实数据里同一节，当前小节写「第一节 if 语句：程序的第一个岔路口（A.05.01）」，
 *  已讲完清单写「第一节 if 语句与代码块（A.05.01，微点 1.1~1.4）」——模型每次复述的详略不同，
 *  全等比较会让陈旧检测永远失效。这里按"编号 / 教材编码 / 包含关系"判定。 */
function sameSection(a, b) {
  const na = String(a ?? '').trim();
  const nb = String(b ?? '').trim();
  if (!na || !nb) return false;
  if (na === nb) return true;
  const code = (s) => (s.match(/[A-Z]\.\d+\.\d+/i) || [''])[0].toUpperCase();
  const ca = code(na);
  const cb = code(nb);
  if (ca && cb && ca === cb) return true;
  const part = (s) => (s.match(/第[一二三四五六七八九十百零\d]+[节章]/) || [''])[0];
  const pa = part(na);
  const pb = part(nb);
  if (pa && pb && pa === pb) return true;
  const [shorter, longer] = na.length <= nb.length ? [na, nb] : [nb, na];
  return shorter.length >= 4 && longer.includes(shorter);
}

/** 陈旧自愈：已经讲完的小节不该再出现在「当前小节 / 下一小节」里。
 *  两门课的真实脏数据就是这么来的（某门课的 learnedSections 里混着 1.2/1.3/1.4，nextSection 还是 1.3；
 *  某门课 9 节都讲完了，currentSection 还挂着第一节）。返回是否改动。 */
function healState(st) {
  if (!st || typeof st !== 'object') return false;
  let changed = false;
  if (!Array.isArray(st.learnedSections)) { st.learnedSections = []; changed = true; }
  const secs = st.learnedSections;
  const stale = (v) => !!v && secs.some((s) => sameSection(s, v));
  if (stale(st.nextSection)) { st.nextSection = ''; changed = true; }
  if (stale(st.currentSection)) { st.currentSection = ''; changed = true; }
  return changed;
}

/** 从 s 的 pos 处（一个左括号）找到配对的右括号位置；找不到返回 -1 */
function matchParen(s, pos) {
  let depth = 0;
  for (let i = pos; i < s.length; i++) {
    const c = s[i];
    if (c === '（' || c === '(') depth++;
    else if (c === '）' || c === ')') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** 把超长的 chapter 切成「短章名 + 章节备注」。
 *  例：「第2章 Unit 2 Hobbies 开讲（全面学习模式：……）」→ chapter="第2章 Unit 2 Hobbies 开讲"，
 *  chapterNote="全面学习模式：……"。只动超限的，正常的原样不动。返回是否改动。 */
function splitChapter(st) {
  if (!st || typeof st.chapter !== 'string') return false;
  if (st.chapter.length <= LIMITS.chapter) return false;
  const raw = st.chapter.trim();
  const m = raw.search(/[（(；;]/);
  if (m <= 0) {
    st.chapter = raw.slice(0, LIMITS.chapter).trim();
    st.chapterNote = raw.slice(LIMITS.chapter, 300 + LIMITS.chapter).trim();
    return true;
  }
  const head = raw.slice(0, m).trim();
  let tail = raw.slice(m + 1).trim();
  // 切点把左括号吃掉了：去掉与它配对的那个右括号，否则备注里会剩个孤零零的「）」
  const close = matchParen(raw, m);
  if (close > m) {
    const offsetInTail = close - (m + 1);
    if (offsetInTail >= 0 && offsetInTail < tail.length) {
      tail = (tail.slice(0, offsetInTail) + tail.slice(offsetInTail + 1)).trim();
    }
  }
  st.chapter = head || raw.slice(0, LIMITS.chapter).trim();
  st.chapterNote = tail.slice(0, 300);
  return true;
}
// ── 跨会话课程合并（2026-10-18 加）──
// 一门课的状态只应该有一份。以前状态按会话存，同一门课开在两个会话里就变成两本账
// （一个记着第1章学完，另一个在讲第2章）。这里把"教什么、讲到哪"的字段归为一组，
// 开同一门课的会话之间自动合并；`on` / `cwd` 是会话自己的，不参与合并。
const COURSE_SCALARS = ['subject', 'material', 'chapter', 'chapterNote', 'currentSection', 'nextSection',
  'nextChapter', 'dataDir', 'examDate', 'examTypes', 'examScope', 'examPapers'];
const COURSE_ARRAYS = ['learnedSections', 'finished', 'debts', 'generatedChapters', 'learnedChapters'];
const COURSE_FIELDS = [...COURSE_SCALARS, ...COURSE_ARRAYS];

/** 课题名归一化：去掉（…）注释、"上册/下册"、版次等后缀，用于宽松识别"同一门课"（2026-11-03） */
export function normSubject(s) {
  return String(s || '')
    .replace(/[（(][^）)]*[）)]/g, '')
    .replace(/(上|下)册|第[一二三四五六七八九十0-9]+版|教材|课程/g, '')
    .replace(/[\s_·、，,.\-—]+/g, '')
    .toLowerCase();
}

/** 课程键：优先「归一化课题」（同一门课换个叫法也认得出），课题为空才退化为资料目录 */
function courseKeyOf(st) {
  if (!st) return '';
  const sub = normSubject(st.subject);
  if (sub) return 'sub:' + sub;
  const dir = String(st.dataDir || '').trim();
  if (dir) return 'dir:' + path.resolve(dir).toLowerCase();
  return '';
}

/**
 * 课程分组（2026-11-03 接力修复）：
 * 只看课题名会把两门真有同名课题、不同资料目录的课错误合并；只看目录路径又会让
 * 「模型把目录名写错」的接力会话变成另一门课。折中：
 *   - 资料目录确实存在的课 → 以目录为锚，归一化课题名做别名；
 *   - 资料目录不存在的会话（模型填错路径）→ 按归一化课题挂到锚上。
 */
function courseGroups(store) {
  const entries = [];
  for (const [id, st] of Object.entries(store.sessions || {})) {
    if (!st || typeof st !== 'object') continue;
    if (!courseKeyOf(st)) continue;
    entries.push({ id, st });
  }
  const alias = new Map(); // 'sub:xxx' -> 'dir:xxx'（资料目录确实存在的课）
  for (const { st } of entries) {
    const dir = String(st.dataDir || '').trim();
    if (!dir) continue;
    let ok = false;
    try { ok = fs.existsSync(dir); } catch { ok = false; }
    if (ok) alias.set('sub:' + normSubject(st.subject), 'dir:' + path.resolve(dir).toLowerCase());
  }
  const groups = new Map();
  for (const { id, st } of entries) {
    let key = courseKeyOf(st);
    if (key.startsWith('sub:')) key = alias.get(key) || key;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push({ id, st });
  }
  return groups;
}

/**
 * 欠账合并（2026-11-03 补）：同一条欠账在多个会话里是**不同引用**的对象，
 * 不能用 includes 去重，否则每次 sync 都翻一倍（14→28→56）。按 id+text 认同一条，
 * 已销优先、其次取 resolvedAt 更晚的那份。
 */
function mergeDebts(list) {
  const byKey = new Map();
  for (const s of list) {
    for (const d of (Array.isArray(s.debts) ? s.debts : [])) {
      if (!d || typeof d !== 'object') continue;
      const key = `${String(d.id || '')}|${String(d.text || '')}`;
      const prev = byKey.get(key);
      const better = !prev
        || (d.status === 'resolved' && prev.status !== 'resolved')
        || (d.status === prev.status && String(d.resolvedAt || '') > String(prev.resolvedAt || ''));
      if (better) byKey.set(key, d);
    }
  }
  return [...byKey.values()];
}

/** 把同一门课的几个会话合并：标量取 updatedAt 最新的非空值，数组按内容去重（旧→新，保持自然顺序） */
function mergeCourseSessions(list) {
  const sorted = [...list].sort((a, b) => String(a.updatedAt || '').localeCompare(String(b.updatedAt || '')));
  const out = {};
  for (const f of COURSE_SCALARS) {
    out[f] = '';
    for (const s of sorted) if (s[f] !== undefined && s[f] !== null && String(s[f]).trim()) out[f] = s[f];
  }
  for (const f of COURSE_ARRAYS) {
    if (f === 'debts') { out[f] = mergeDebts(sorted); continue; }
    const seen = new Set();
    const arr = [];
    for (const s of sorted) {
      const v = Array.isArray(s[f]) ? s[f] : [];
      for (const item of v) {
        // 字符串直接比；对象（这里不应有，但防一手）按内容 JSON 比，绝不能退回引用比较
        const key = item && typeof item === 'object' ? JSON.stringify(item) : String(item);
        if (seen.has(key)) continue;
        seen.add(key);
        arr.push(item);
      }
    }
    out[f] = arr;
  }
  return out;
}

/** 把所有"同一门课"的会话并成一份账。返回被改动过的会话数。幂等：已经一致时返回 0。 */
function syncCourses(store) {
  let changed = 0;
  for (const list of courseGroups(store).values()) {
    if (list.length < 2) continue;
    const merged = mergeCourseSessions(list.map((x) => x.st));
    for (const { st } of list) {
      let touched = false;
      for (const f of COURSE_FIELDS) {
        const a = JSON.stringify(st[f] === undefined ? null : st[f]);
        const b = JSON.stringify(merged[f] === undefined ? null : merged[f]);
        if (a !== b) { st[f] = merged[f]; touched = true; }
      }
      if (touched) changed++;
    }
  }
  return changed;
}

/** 同一门课的其它会话（给注入头与 status 用） */
function peersOf(store, sessionId) {
  const me = store.sessions?.[sessionId];
  if (!me || !courseKeyOf(me)) return [];
  for (const list of courseGroups(store).values()) {
    if (list.some((x) => x.id === sessionId)) {
      return list.filter((x) => x.id !== sessionId).map((x) => ({ id: x.id, on: !!x.st.on }));
    }
  }
  return [];
}

/**
 * 接力线索（2026-11-03）：会话还没开课、或还没记课题时，把这个工作区里已有的课
 * 一行一门列给模型。否则模型只会去读 README 手工续进度，账全落在插件之外。
 */
/** 状态库键名形如 session-<uuid>，直接 slice(0, 8) 只会得到 'session-'，毫无区分度。 */
export function shortId(id, n = 8) {
  const s = String(id == null ? '' : id).replace(/^session-/, '');
  return s.slice(0, n) || '-';
}

function courseHintText(store, sessionId) {
  const me = store.sessions?.[sessionId];
  if (me && me.subject) return '';               // 本会话已记课题，不需要线索
  const cwd = me?.cwd || '';
  const lines = [];
  for (const [id, st] of Object.entries(store.sessions || {})) {
    if (id === sessionId || !st || !st.subject) continue;
    if (cwd && st.cwd && String(st.cwd) !== String(cwd)) continue;
    const n = Array.isArray(st.learnedSections) ? st.learnedSections.length : 0;
    // 未销口径必须与 openDebts 一致（status === 'open'）；早先这里用 !d.resolved，
    // 而欠账对象早已改成 status 字段，导致"全已销"的课在接力线索里显示成 N 笔未销（2026-11-03 修）
    const open = Array.isArray(st.debts) ? st.debts.filter((d) => d && (d.status ? d.status === 'open' : !d.resolved)).length : 0;
    if (!st.chapter && !n) continue;
    lines.push(`- 「${st.subject}」：${st.chapter || '未记当前章'}，已讲 ${n} 节${open ? `，${open} 笔欠账未销` : ''}（会话 ${shortId(id)}）`);
  }
  if (!lines.length) return '';
  return '\n\n### 本工作区已有的课（接力线索）\n'
    + '学生这次可能是在**继续**下面某一门课。若如此：先调 teaching_setup，课题名照抄或换个叫法都行（插件按归一化课题认同一门课），'
    + '资料目录会自动沿用已存在的那个，历史进度会自动接上；不要从零开课、不要另建资料目录、不要只读 README 手工续账。\n'
    + lines.slice(0, 3).join('\n');
}

// ── 状态库 ──

/** 默认状态文件路径 */
function defaultStatePath() {
  const home = process.env.DSH_HOME || process.env.USERPROFILE || process.env.HOME || process.cwd();
  return path.join(home, '.dsh', 'teaching-mode', 'state.json');
}

function normalizeState(raw) {
  const base = EMPTY_STATE();
  if (!raw || typeof raw !== 'object') return base;
  for (const [k, v] of Object.entries(raw)) {
    if (v === undefined || v === null) continue;
    base[k] = v;
  }
  for (const f of ['learnedSections', 'finished', 'debts', 'generatedChapters', 'learnedChapters', 'recentMistakes']) {
    if (!Array.isArray(base[f])) base[f] = [];
  }
  base.on = base.on === true;
  // 备课闸门：只认两个合法值，旧状态没有这个字段就是 ''（由 prepStateOf 推导）
  base.prep = base.prep === 'pending' || base.prep === 'confirmed' ? base.prep : '';

  // v0.8.0：欠账从字符串升级为可销账条目。旧数据原地迁移，幂等（重复加载结果不变）
  const debts = [];
  for (const d of base.debts) {
    if (typeof d === 'string') {
      debts.push({ id: '', text: d, status: 'open', addedAt: base.updatedAt || '', resolvedAt: '', note: '' });
    } else if (d && typeof d === 'object' && typeof d.text === 'string') {
      debts.push({
        id: String(d.id ?? ''),
        text: d.text,
        status: d.status === 'resolved' || d.status === 'dropped' ? d.status : 'open',
        addedAt: String(d.addedAt ?? ''),
        resolvedAt: String(d.resolvedAt ?? ''),
        note: String(d.note ?? ''),
      });
    }
  }
  let seq = Number(base.debtSeq) || 0;
  for (const d of debts) {
    const n = Number(d.id);
    if (!n) { seq += 1; d.id = String(seq); } else if (n > seq) seq = n;
  }
  base.debts = debts;
  base.debtSeq = seq;

  if (!base.mistakeStats || typeof base.mistakeStats !== 'object') base.mistakeStats = { total: 0, byLayer: {} };
  base.mistakeStats.total = Number(base.mistakeStats.total) || 0;
  if (!base.mistakeStats.byLayer || typeof base.mistakeStats.byLayer !== 'object') base.mistakeStats.byLayer = {};

  // v0.10 开课状态机。phase 只认四个合法值，'' 表示"旧状态、按进度推导"（老课不能被升级打回）
  base.phase = PHASES.includes(String(base.phase || '')) ? String(base.phase) : '';
  base.materialMode = base.materialMode === 'textbook' || base.materialMode === 'outline' ? base.materialMode : '';
  base.requirements = String(base.requirements || '');
  base.receipt = String(base.receipt || '');
  base.startedAt = String(base.startedAt || '');
  const sy = base.syllabus;
  if (sy && typeof sy === 'object') {
    base.syllabus = {
      mode: sy.mode === 'chapter' || sy.mode === 'L' || sy.mode === 'custom' ? sy.mode : '',
      path: String(sy.path || ''),
      microCount: Number(sy.microCount) || 0,
      lineCount: Number(sy.lineCount) || 0,
      confirmedAt: String(sy.confirmedAt || ''),
    };
  } else base.syllabus = null;
  return base;
}

/** 从「第5章 分支结构」里取出章号 5；取不到返回空串 */
function chapterNo(label) {
  const m = String(label || '').match(/第\s*(\d+)\s*章/);
  return m ? m[1] : '';
}

/**
 * 章末总复习文件是否存在。
 * 返回 true=有、false=没有、null=没有资料落盘目录（无法校验，不拦）。
 */
function hasChapterReview(st, chapter) {
  if (!st || !st.dataDir) return null;
  const no = chapterNo(chapter) || chapterNo(st.chapter);
  let names = [];
  try { names = fs.readdirSync(st.dataDir); } catch { return false; }
  return names.some((n) => {
    const low = n.toLowerCase();
    if (!low.endsWith('.md')) return false;
    if (!n.includes('总复习')) return false;
    if (no) return n.includes(`第${no}章`);
    return n.includes(String(chapter).slice(0, 8));
  });
}

/** 重建资料目录的「课程索引.md」（按第N章分组），返回文件路径；没有目录返回空串 */
function rebuildIndex(st) {
  if (!st || !st.dataDir) return '';
  const dir = st.dataDir;
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return ''; }
  const exts = new Set(['.md', '.docx', '.pdf']);
  const files = names.filter((n) => exts.has(path.extname(n).toLowerCase()) && n !== '课程索引.md');
  if (!files.length) return '';
  const typeOf = (n) => {
    if (n.includes('总复习')) return '章总复习';
    if (n.includes('复习资料')) return '小节复习';
    if (n.includes('讲义')) return '讲义';
    if (n.includes('错题本')) return '错题本';
    if (n.includes('试卷') || n.includes('卷')) return '试卷';
    return '其它';
  };
  const groups = new Map();
  for (const n of files) {
    const m = n.match(/第\s*(\d+)\s*章/);
    const key = m ? `第${m[1]}章` : '未分章';
    if (!groups.has(key)) groups.set(key, []);
    let mt = '';
    try { mt = fs.statSync(path.join(dir, n)).mtime.toISOString().slice(0, 10); } catch { /* 忽略 */ }
    groups.get(key).push({ n, mt, type: typeOf(n) });
  }
  const order = [...groups.keys()].sort((a, b) => {
    const na = Number((a.match(/\d+/) || [])[0] || 999);
    const nb = Number((b.match(/\d+/) || [])[0] || 999);
    return na - nb;
  });
  const lines = [
    '# 课程索引',
    '',
    `> 由 dsh-teaching-mode 自动生成（${new Date().toISOString().slice(0, 16).replace('T', ' ')}）。按「第N章」分组；新增文件后会自动重建。`,
    '',
  ];
  for (const k of order) {
    const list = groups.get(k).sort((a, b) => a.n.localeCompare(b.n, 'zh'));
    lines.push(`## ${k}（${list.length} 个）`, '', '| 文件 | 类型 | 更新日期 |', '|---|---|---|');
    for (const f of list) lines.push(`| ${f.n} | ${f.type} | ${f.mt} |`);
    lines.push('');
  }
  const file = path.join(dir, '课程索引.md');
  try { fs.writeFileSync(file, lines.join('\n'), 'utf8'); return file; } catch { return ''; }
}

// ── 欠账 / 错题（v0.8.0 复习闭环） ──

const DEBT_STATUS_TEXT = { open: '未销', resolved: '已销', dropped: '作废' };
const MISTAKE_LAYERS = ['概念', '推理', '记法', '计算', '粗心'];

/** 未销欠账 */
function openDebts(st) {
  return (Array.isArray(st.debts) ? st.debts : []).filter((d) => d && d.status === 'open');
}

/** 新增一条欠账，返回条目 */
function pushDebt(st, text) {
  if (!Array.isArray(st.debts)) st.debts = [];
  st.debtSeq = (Number(st.debtSeq) || 0) + 1;
  const item = { id: String(st.debtSeq), text, status: 'open', addedAt: new Date().toISOString(), resolvedAt: '', note: '' };
  st.debts.push(item);
  return item;
}

/** 按编号或关键词找欠账（先编号，再未销条目里按内容匹配） */
function findDebt(st, key) {
  const k = String(key || '').trim();
  if (!k) return null;
  const all = Array.isArray(st.debts) ? st.debts : [];
  const byId = all.find((d) => d && String(d.id) === k);
  if (byId) return byId;
  return openDebts(st).find((d) => d.text.includes(k)) || null;
}

/** 销账 / 作废；已销的只留最近 N 条，防止状态文件无限长 */
function closeDebt(st, item, status, note) {
  item.status = status;
  item.resolvedAt = new Date().toISOString();
  if (note) item.note = note;
  const closed = st.debts.filter((d) => d && d.status !== 'open');
  if (closed.length > LIMITS.debtsResolved) {
    const keep = new Set(closed.slice(-LIMITS.debtsResolved).map((d) => d.id));
    st.debts = st.debts.filter((d) => d.status === 'open' || keep.has(d.id));
  }
}

/** 记一条错题：state 只存计数与摘要 */
function addMistake(st, m) {
  if (!Array.isArray(st.recentMistakes)) st.recentMistakes = [];
  if (!st.mistakeStats || typeof st.mistakeStats !== 'object') st.mistakeStats = { total: 0, byLayer: {} };
  const layer = MISTAKE_LAYERS.includes(m.layer) ? m.layer : '未分层';
  st.mistakeStats.total = (Number(st.mistakeStats.total) || 0) + 1;
  st.mistakeStats.byLayer[layer] = (Number(st.mistakeStats.byLayer[layer]) || 0) + 1;
  const item = {
    topic: String(m.topic || '').slice(0, 40),
    layer,
    question: String(m.question || '').replace(/\s+/g, ' ').slice(0, 60),
    at: new Date().toISOString(),
  };
  st.recentMistakes.unshift(item);
  if (st.recentMistakes.length > 10) st.recentMistakes = st.recentMistakes.slice(0, 10);
  return item;
}

/** 错题明细追加到 <资料落盘目录>/错题本.md，返回文件路径（写不了就返回空） */
function writeMistakeNote(st, m) {
  if (!st.dataDir) return '';
  const file = path.join(st.dataDir, '错题本.md');
  const head = '# 错题本\n\n> 由 dsh-teaching-mode 自动追加。错层 = 概念 / 推理 / 记法 / 计算 / 粗心 —— 错在哪一层，比错几道更重要。\n\n| 时间 | 知识点 | 题目 | 我的答案 | 正确答案 | 错因 | 错层 |\n|---|---|---|---|---|---|---|\n';
  const esc = (s) => String(s ?? '').replace(/\|/g, '｜').replace(/\r?\n/g, ' ').slice(0, 120);
  try {
    fs.mkdirSync(st.dataDir, { recursive: true });
    if (!fs.existsSync(file)) fs.writeFileSync(file, head, 'utf8');
    else {
      // v0.10：模型手工 write 覆盖整份错题本后，表头会丢——下次追加时补回来并留痕
      const cur = fs.readFileSync(file, 'utf8');
      if (!cur.includes('| 时间 |')) {
        fs.appendFileSync(file, '\n' + head + '\n> ⚠ 检测到表头缺失，已自动补回（文件可能被整份覆盖过，请只用 teaching_mistake 追加）。\n', 'utf8');
      }
    }
    const at = new Date().toISOString().slice(0, 16).replace('T', ' ');
    fs.appendFileSync(file, `| ${at} | ${esc(m.topic)} | ${esc(m.question)} | ${esc(m.myAnswer)} | ${esc(m.correct)} | ${esc(m.cause)} | ${esc(m.layer)} |\n`, 'utf8');
    return file;
  } catch {
    return '';
  }
}

function loadStore(statePath) {
  let raw = null;
  try { raw = JSON.parse(fs.readFileSync(statePath, 'utf8')); } catch { raw = null; }
  const store = { version: 1, sessions: {}, migrated: false };
  if (raw && typeof raw === 'object') {
    store.version = 1;
    const sessions = raw.sessions && typeof raw.sessions === 'object' ? raw.sessions : {};
    for (const [id, st] of Object.entries(sessions)) {
      const norm = normalizeState(st);
      store.sessions[id] = norm;
      // v0.8.0：旧结构（欠账是字符串）会在 normalizeState 里升级；发现结构变了就标记，apply 时落盘一次
      try { if (JSON.stringify(st) !== JSON.stringify(norm)) store.migrated = true; } catch { store.migrated = true; }
    }
  }
  return store;
}

function writeAtomic(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp-' + process.pid;
  fs.writeFileSync(tmp, text, 'utf8');
  fs.renameSync(tmp, file);
}

export function apply(ctx, config = {}) {
  const cfg = config && typeof config === 'object' ? config : {};
  const statePath = String(cfg.statePath || '').trim() || defaultStatePath();
  const defaultOn = cfg.defaultOn === true;
  const logFile = path.join(path.dirname(statePath), 'dsh-teaching-mode.log');
  const diag = (msg) => {
    try {
      fs.mkdirSync(path.dirname(logFile), { recursive: true });
      fs.appendFileSync(logFile, `${new Date().toISOString()} v${VERSION} pid=${process.pid} ${msg}\n`, 'utf8');
    } catch { /* 诊断日志失败不影响功能 */ }
    try { ctx.logger?.info?.(`[teaching-mode] ${msg}`); } catch { /* 忽略 */ }
  };

  const store = loadStore(statePath);
  const stateOf = (id) => (id ? store.sessions[id] : undefined);
  // 索引重建去重（2026-10-22）：以前每次落盘都把**所有**会话的资料目录全量扫一遍，
  // 目录里文件一多（讲义、错题本、真题），每次工具调用都在 statSync 扫盘 → 用户感觉「整理慢、反应慢」。
  // 现在按「文件清单签名」判断：清单没变就不重建（只多一次 readdirSync，很便宜）；
  // 新增/删除讲义后签名必变，索引照样立即更新，不会漏。
  const lastIndexSig = new Map();
  // ── 出题门禁所需的讲解记录（v0.10：按学生消息轮累计，跨 assistant 消息）──
  // 旧版只记「包含 tool call 那一步的文本」：模型把正文发一条、题目卡片发下一条时读到 0 字，
  // 真机上连拒 8 次（日志 chars=0）。现在正文一律往 lessonBuf 里累加，学生发新消息才清空。
  const LESSON_MIN_CHARS = 150;
  // 讲授结构检查（2026-11-03 v0.9.4 加）。
  // 真机教训：Python 第8章第二节讲到微点 4 时，模型把「答对了…」的批改写完就直接出下一题，
  // 正文早已超过 150 字，光看字数根本挡不住。所以除字数外还要求正文里同时出现
  // 「是什么类」与「为什么类」的表述——批改段落通常只有"因为错在哪"，没有定义与推导。
  // LESSON_WHAT / LESSON_WHY 定义在模块级（lectureSignal 是模块级函数，引用不到这里的闭包变量）
  const lessonBuf = new Map();   // sessionId -> { seq, text } 本次学生消息之后的全部正文
  const lessonSeq = new Map();   // sessionId -> 序号，学生每发一条消息 +1
  const attemptTurn = new Map(); // attemptId -> { sid } 流式片段的归属
  const gatePassed = new Map();  // sessionId -> seq   该讲次已放行过出题
  // 学生答完一道卡片题后记一笔：{ seq, len } = 答题时正文所在的讲次与长度。
  // 真机事故（2026-11-12 汇编课）：学生用卡片作答，答案走 tool/result 回来，不产生 inbox 消息，
  // clearLesson 不触发，lessonBuf 里还留着上一轮正文——模型不写新讲解直接出下一题，门禁照样放行。
  const answeredAt = new Map();
  const ANSWERED_MIN_CHARS = 120; // 答题后至少要新增这么多讲解，才允许出下一题
  const bufOf = (sid) => {
    let b = lessonBuf.get(sid);
    if (!b) { b = { seq: lessonSeq.get(sid) || 0, text: '' }; lessonBuf.set(sid, b); }
    return b;
  };
  /** 学生发新消息：上一轮的讲解作废，出题门禁重新计数（2026-11-11 v0.10） */
  const clearLesson = (sid) => {
    if (!sid) return;
    const seq = (lessonSeq.get(sid) || 0) + 1;
    lessonSeq.set(sid, seq);
    lessonBuf.set(sid, { seq, text: '' });
    gatePassed.delete(sid);
    answeredAt.delete(sid);
  };
  // ── 纯文本出题的事后纠偏（2026-11-04 v0.9.6）──
  // 真机教训：英语课的单元卷、ABCD 选择题、默写都是模型直接写在回复正文里的，
  // 不经过任何工具调用，examGate（只拦 ask_user_question）永远触发不到；
  // 宿主也没有「发送前拦截回复」的钩子，所以只能事后判定 + 下一轮强制补讲。
  const QUIZ_OPTION_RE = /(?:^|[\s（(])[A-DＡ-Ｄ][.、．)）]/g;
  const QUIZ_ITEM_RE = /(?:^|\n)[ \t]*\d{1,2}[.、．)）][ \t]*\S/g;
  const QUIZ_MIN_CHARS = 220;   // 太短不判，防误杀闲聊
  /** 本轮正文像不像「只出题没讲」；返回 null 表示正常 */
  const looksLikeQuizDump = (text) => {
    const t = String(text || '');
    if (t.length < QUIZ_MIN_CHARS) return null;
    if (LESSON_WHAT.test(t) && LESSON_WHY.test(t)) return null; // 有定义+推导，算讲了
    const options = (t.match(QUIZ_OPTION_RE) || []).length;
    const items = (t.match(QUIZ_ITEM_RE) || []).length;
    if (options >= 4 || items >= 3) return { options, items };
    return null;
  };
  /** 一轮流结束后判定：命中就记账，等下一轮补讲 */
  const judgeTurn = (owner) => {
    if (!owner || !owner.sid) return;
    const st = stateOf(owner.sid);
    if (!st || st.on !== true || !st.subject) return;
    const buf = bufOf(owner.sid);
    const seq = buf.seq;
    const hit = looksLikeQuizDump(buf.text);
    if (!hit) return;
    if (st.quizDump && st.quizDump.seq === seq) return; // 同一次讲解里只记一次
    st.quizDump = { seq, at: Date.now(), options: hit.options, items: hit.items };
    try { persist(); } catch { /* 落盘失败也要在本进程内生效 */ }
    diag('quiz-dump seq=' + seq + ' opt=' + hit.options + ' items=' + hit.items);
  };
  const watchStream = (payload) => {
    try {
      const frame = payload?.frame;
      const sid = payload?.agent?.id;
      if (!frame || !sid) return;
      if (frame.type === 'start') {
        attemptTurn.set(frame.attemptId, { sid });
        return;
      }
      if (frame.type === 'end') {
        const owner = attemptTurn.get(frame.attemptId);
        attemptTurn.delete(frame.attemptId);
        try { judgeTurn(owner); } catch { /* 判定失败不影响主流程 */ }
        return;
      }
      if (frame.type !== 'chunk') return;
      const chunk = frame.chunk;
      if (!chunk) return;
      const a = attemptTurn.get(frame.attemptId);
      if (!a) return;
      const cur = bufOf(a.sid);
      // 正路：流式增量
      if (chunk.type === 'text-delta' && chunk.text) {
        if (cur.text.length < 60000) cur.text += chunk.text; // 防御：单讲次正文不让内存无限涨
        return;
      }
      // 兜底：万一 provider 或转接层不走流式增量，只在 block-end 给整块文本，
      // 这里取「更长的那个」，避免把「没收到 delta」误判成「没讲」而拦死所有出题。
      if (chunk.type === 'block-end') {
        const b = chunk.block;
        if (b && b.type === 'text' && typeof b.text === 'string' && b.text.length > cur.text.length) cur.text = b.text;
      }
    } catch { /* 监听异常绝不影响主流程 */ }
  };
  /** 出题门禁：教师模式开启时，本轮没有足够讲解就不许出题卡片 */
  const examGate = (exec) => {
    try {
      if (!exec || exec.name !== 'ask_user_question') return undefined;
      const sid = exec.agent?.id;
      if (!sid) return undefined;
      const st = store.sessions[sid];
      if (!st || !st.on) return undefined;
      const args = exec.args || exec.arguments || exec.input || {};
      // 1) 确认型卡片（要不要继续 / 选目录格式 / 信息对不对）：不要求先讲解，也不查题干
      //    先于题干检查，避免「插件开发 / 管理对话」里的普通问询卡被当成教学题误伤（2026-11-12 实测）。
      if (isConfirmCard(args)) { diag('gate-pass-confirm ' + shortId(sid)); return undefined; }
      // 2) 阶段闸门：备课 / 待确认大纲 / 待开课阶段，不许出教学内容题；问询卡片放行
      const phaseBad = phaseGateReason(st, args);
      if (phaseBad) { diag('gate-deny-phase ' + shortId(sid)); return phaseBad; }
      // 3) 无课题＝开课前问询：不查题干、不查讲解（2026-11-12 开发对话被 auto-on 误伤）
      if (!st.subject) return undefined;
      // 4) 题干检查：代码必须在正文，题干只写中文，选项不许暗示
      const cardBad = checkCardPayload(args);
      if (cardBad) {
        diag('gate-deny-card ' + shortId(sid) + ' ' + cardBad);
        return '【教师模式门禁·出题被拒绝】' + cardBad + '。\n'
          + '正确做法：把这段代码放进正文的代码框（三个反引号），题干只用中文说「上面的代码……」，然后重试。';
      }
      // 5) 讲解信号：本次学生消息之后累计的正文，任一强信号成立即放行
      const buf = bufOf(sid);
      // 6) 上一题刚答完：必须写出新的讲解才允许出下一题（否则就是「只发题不发正文」）
      const ans = answeredAt.get(sid);
      if (ans && ans.seq === buf.seq && buf.text.length - ans.len < ANSWERED_MIN_CHARS) {
        const added = buf.text.length - ans.len;
        diag('gate-deny-answered ' + shortId(sid) + ' added=' + added);
        return '【教师模式门禁·出题被拒绝】上一题学生已经作答，但你在这之后只写了 ' + added + ' 字，没有再讲解就出了下一题。'
          + '批改（「答对了 / 你错在…」）不算讲解；进入下一个微点必须重新起一段完整讲解，'
          + '即使是在同一个知识点里追加第 2、3 道题，也要先把这次的考点讲清楚。\n'
          + '正确做法：先按模板写「### 是什么 / ### 为什么 / ### 例子」讲完这个微点，再重试出题。';
      }
      if (gatePassed.get(sid) === buf.seq) return undefined; // 本次讲次已放行过，允许连出
      const sig = lectureSignal(buf.text);
      if (sig.ok) {
        gatePassed.set(sid, buf.seq);
        diag('gate-pass ' + shortId(sid) + ' chars=' + buf.text.length + ' hit=' + sig.hit);
        return undefined;
      }
      diag('gate-deny ' + shortId(sid) + ' chars=' + buf.text.length + ' hit=' + sig.hit + ' h=' + sig.headings + ' code=' + (sig.hasCode ? 1 : 0));
      return '【教师模式门禁·出题被拒绝】这次学生提问之后，你还没有讲知识点就出了题。'
        + '（本次已累计正文 ' + buf.text.length + ' 字；判定信号：坐标行、至少 2 个 ### 段标题、代码块+120字、300字以上正文、是什么+为什么各一段——一个都没命中。）\n'
        + '这不是提醒，是硬性拒绝。请在同一条回复里按顺序补完再重试：\n'
        + '1) 开头写坐标行：「▍第X章 · 第Y节 · 微点N/M · ★★★」；\n'
        + '2) 用 ### 分段，至少写「是什么」「为什么成立」「例子」三段；\n'
        + '3) 例子要进代码框（Python 代码块），题干只考刚讲的这个微点。\n'
        + '注意：只写批改（「答对了 / 你错在…」）不算讲解，批改完要进入下一个微点必须重新起一段讲它。\n'
        + '如果这次调用不是出题而是课前问询（问课题、教材、考试范围、要不要继续），请改用 ≤3 个选项、不带微点编号的问询卡片。';
    } catch (e) {
      // 门禁自身出错不能静默放行——至少留一条日志，便于排查（2026-11-11）
      diag('gate-error ' + (e && e.message ? e.message : String(e)));
      return undefined;
    }
  };
  const persist = () => {
    try { syncCourses(store); } catch { /* 合并失败也照常落盘，不能因此丢数据 */ }
    try { writeAtomic(statePath, JSON.stringify({ version: 1, sessions: store.sessions }, null, 2)); } catch (e) {
      diag('persist-failed ' + (e && e.message ? e.message : String(e)));
    }
    // 归档索引：兜底重建（幂等、只扫资料目录顶层）
    try {
      for (const st of Object.values(store.sessions)) {
        if (!st || !st.dataDir) continue;
        let sig = '';
        try {
          sig = fs.readdirSync(st.dataDir).filter((n) => n !== '课程索引.md').sort().join('|');
        } catch { continue; }
        if (!sig) continue;
        if (sig === lastIndexSig.get(st.dataDir)) continue;
        lastIndexSig.set(st.dataDir, sig);
        rebuildIndex(st);
      }
    } catch (e) {
      diag('index-failed ' + (e && e.message ? e.message : String(e)));
    }
  };

  // 启动自愈：把历史上攒下来的脏数据修掉（幂等）
  try {
    let repaired = 0;
    for (const st of Object.values(store.sessions)) {
      let touched = false;
      if (healState(st)) touched = true;
      if (splitChapter(st)) touched = true;
      // 落盘目录指到不存在的目录（接力时改了课题名的后遗症）→ 按课题重算 / 找已存在的同名课（2026-11-03）
      if (ensureDataDir(st, st.cwd || '')) touched = true;
      if (touched) { st.updatedAt = new Date().toISOString(); repaired++; }
    }
    if (repaired) { persist(); diag('apply:repaired ' + repaired); }
    const synced = syncCourses(store);
    if (synced) { persist(); diag('apply:courses-synced ' + synced); }
    if (store.migrated) { persist(); diag('apply:state-migrated'); }
  } catch (e) {
    diag('apply:repair-failed ' + (e && e.message ? e.message : String(e)));
  }
  diag('apply:enter state=' + statePath);

  // ── 注入：按 context 里的会话身份取本会话状态（不串台）──
  const pickSessionId = (context) => {
    const cands = [context?.scope?.id, context?.agent?.id, context?.session?.id, context?.sessionId];
    for (const c of cands) if (typeof c === 'string' && c) return c;
    return '';
  };

  try {
    if (ctx.systemPrompt && typeof ctx.systemPrompt.section === 'function') {
      // ── 新会话教程（2026-11-03 v0.9.5）──
      // 客户端半在这台机器上加载即卡死 boot（见 04-日志/2026-11-03-v0.9.5-新手引导条.md），
      // 所以教程只能走对话：把「原话输出这三句」作为任务塞进注入最末尾，每个会话一次。
      const welcomed = new Set();
      const welcomeOnce = (id, st) => {
        if (!id || welcomed.has(id)) return '';
        if (st && st.welcomeSeen) return '';
        welcomed.add(id);
        if (st) {
          st.welcomeSeen = true;
          try { persist(); } catch { /* 落盘失败就只在本进程内记住，不重复打扰 */ }
        }
        return WELCOME_INSTRUCTION;
      };
      const QUIZ_FIX_INSTRUCTION = [
        '',
        '---',
        '【教师模式·上一轮违规，本轮必须纠正】',
        '你上一轮直接写了 {N} 道题，却没有先讲对应的知识点。那批题目全部作废：',
        '学生答了也不算进度，错题不要记账，讲解进度不要往前推。',
        '本轮必须先把那一个知识点补讲完——它是什么、为什么成立、完整走一个例子；',
        '讲完再问学生懂不懂，然后才可以重新出题。不许跳过讲解直接继续出题或跳下一节。',
      ].join('\n');
      /** 上一轮违规出题就在本轮开头强制补讲；注入一次即清空 */
      const quizFix = (st) => {
        if (!st || !st.quizDump) return '';
        const n = st.quizDump.items || st.quizDump.options || 0;
        try { delete st.quizDump; persist(); } catch { /* 忽略 */ }
        diag('quiz-fix-injected n=' + n);
        return '\n\n' + QUIZ_FIX_INSTRUCTION.replace('{N}', String(n));
      };
      const register = () => {
        ctx.systemPrompt.section({
          name: TEACHING_SECTION,
          order: 950,
          text: (context) => {
            try {
              const id = pickSessionId(context);
              let st = id ? stateOf(id) : undefined;
              if (!st) {
                // 没有本会话状态：只给识别提示 + 接力线索。
                // 不再"恰好一门课开着就借它的状态"——那是串台，会让新会话冒充旧课（2026-11-03）。
                return composeRules(null, cfg) + courseHintText(store, id) + welcomeOnce(id, st);
              }
              const cwd = st.cwd || context?.scope?.cwd || context?.cwd || '';
              if (ensureDataDir(st, cwd)) persist();
              const merged = healState(st) ? (persist(), st) : st;
              if (merged.on !== true) return composeRules(merged, cfg) + courseHintText(store, id) + welcomeOnce(id, merged);
              return composeRules(merged, cfg, peersOf(store, id || '')) + welcomeOnce(id, merged) + quizFix(merged);
            } catch (e) {
              diag('section-text-failed ' + (e && e.message ? e.message : String(e)));
              return composeRules(null, cfg);
            }
          },
        });
        diag('apply:section-ok');
      };
      if (typeof ctx.effect === 'function') ctx.effect(register, 'teaching-mode:section');
      else register();
    }
  } catch (e) {
    diag('apply:section-failed ' + (e && e.message ? e.message : String(e)));
  }

  // ── 命令 ──
  const handler = makeTeachingHandler({ store, persist, stateOf, cfg, diag, peersOf, defaultOn });
  try {
    if (typeof ctx.inject === 'function') {
      ctx.inject(['commands'], (services) => {
        try {
          services.commands.register({
            name: 'teaching',
            description: '教师模式：on 开启 / off 关闭 / status 查看 / setup 设置课题与教材 / courses 列课 / link 接力 / repair 修状态 / prune 清空壳',
            handler,
          });
          diag('apply:command-ok');
        } catch (e) {
          diag('apply:command-failed ' + (e && e.message ? e.message : String(e)));
        }
      });
    }
  } catch (e) {
    diag('apply:command-inject-failed ' + (e && e.message ? e.message : String(e)));
  }

  // ── 模型工具（让 AI 自己记状态，学生不用敲命令）──
  try {
    if (typeof ctx.inject === 'function') {
      ctx.inject(['tools'], (services) => {
        try {
          const tools = buildTools({ store, persist, stateOf, cfg, diag, peersOf, deriveDataDir, tooLong, LIMITS, ensureDataDir });
          let ok = 0;
          for (const t of tools) {
            try { services.tools.register(t); ok++; } catch (e) { diag('tool-register-failed ' + t.name + ' ' + (e && e.message ? e.message : String(e))); }
          }
          diag('apply:tools-ok ' + ok);
          // ── 出题硬门禁（2026-10-23 v0.9.1）──
          // guard 在 tools/pre-execute 之后执行，返回字符串即拒绝该次调用。
          try {
            if (typeof services.tools.guard === 'function') {
              const registerGuard = () => services.tools.guard(examGate);
              if (typeof ctx.effect === 'function') ctx.effect(registerGuard, 'teaching-mode:exam-gate');
              else registerGuard();
              diag('apply:exam-gate-ok');
            } else diag('apply:exam-gate-skip no-guard-api');
          } catch (e) {
            diag('apply:exam-gate-failed ' + (e && e.message ? e.message : String(e)));
          }
        } catch (e) {
          diag('apply:tools-failed ' + (e && e.message ? e.message : String(e)));
        }
      });
    }
  } catch (e) {
    diag('apply:tools-inject-failed ' + (e && e.message ? e.message : String(e)));
  }

  // ── 事件：新会话 / 用户消息自动识别开场与下课 ──
  try {
    if (typeof ctx.on === 'function') {
      ctx.on('session/created', (session) => {
        try {
          const id = session?.id;
          if (!id) return;
          const cwd = session?.header?.cwd || '';
          const existed = !!store.sessions[id];
          const st = existed ? store.sessions[id] : normalizeState({ on: defaultOn, cwd, updatedAt: new Date().toISOString() });
          if (!existed) store.sessions[id] = st;
          if (cwd) st.cwd = cwd;
          if (!existed) { persist(); diag('session-created-ok ' + shortId(id)); }
          else diag('session-seen ' + shortId(id));
        } catch (e) {
          diag('session-created-failed ' + (e && e.message ? e.message : String(e)));
        }
      }, 'teaching-mode:session-created');

      ctx.on('agent/inbox/claimed', (payload) => {
        try {
          const id = payload?.agent?.id;
          if (!id) return;
          const text = messageText(payload?.message);
          if (!text) return;
          clearLesson(id); // 学生发新消息：上一轮讲解作废，出题门禁重新计数（v0.10）
          if (OFF_RE.test(text) && !OFF_NEG.test(text)) { toggle(id, false); diag('auto-off ' + shortId(id)); }
          else if (ON_RE.test(text) && !ON_NEG.test(text)) { toggle(id, true); diag('auto-on ' + shortId(id)); }
        } catch (e) {
          diag('auto-detect-failed ' + (e && e.message ? e.message : String(e)));
        }
      }, 'teaching-mode:auto-detect');

      // 学生答完卡片题：答案走 tool/result 回来，不会触发 inbox 消息（2026-11-12 汇编课事故）。
      // 记下答题时的讲次与正文长度，门禁据此要求「出下一题之前必须新增讲解」。
      ctx.on('tools/result', (exec, result) => {
        try {
          if (!exec || exec.name !== 'ask_user_question') return;
          const sid = exec.agent?.id || exec.session?.id || exec.sessionId;
          if (!sid) return;
          const raw = JSON.stringify(result ?? '');
          if (raw.includes('【教师模式门禁')) return; // 被门禁拒绝的调用不算学生作答
          const buf = bufOf(sid);
          answeredAt.set(sid, { seq: buf.seq, len: buf.text.length });
          diag('answered ' + shortId(sid) + ' seq=' + buf.seq + ' len=' + buf.text.length);
        } catch (e) {
          diag('answered-failed ' + (e && e.message ? e.message : String(e)));
        }
      }, 'teaching-mode:answered');
      diag('apply:events-ok');
    }
  } catch (e) {
    diag('apply:events-failed ' + (e && e.message ? e.message : String(e)));
  }

  // ── 监听本轮正文流：给「没讲就出题」门禁提供判定依据（2026-10-23 v0.9.1）──
  try {
    ctx.on('agent/assistant-stream', watchStream, 'teaching-mode:lesson-watch');
    diag('apply:lesson-watch-ok');
  } catch (e) {
    diag('apply:lesson-watch-failed ' + (e && e.message ? e.message : String(e)));
  }

  function toggle(id, on) {
    const st = store.sessions[id] || normalizeState({ on: false, updatedAt: new Date().toISOString() });
    store.sessions[id] = st;
    st.on = on;
    st.updatedAt = new Date().toISOString();
    persist();
  }

  diag('apply:done');
}
const TEACHING_SECTION = 'teaching-mode:rules';

/** 开场 / 下课 触发词（只认明确表达，日常提问不得误触发） */
// 2026-11-11 v0.10：去掉裸「上课」「教我」——真机上「还没开启教师模式是吧」被误判成开启；
// 再加一道否定排除：「不用/别/还没」后面跟开启动作不算开启。
const ON_RE = /(开启|打开|进入|用|启用)\s*教师模式|教师模式[，,]?\s*(开启|开一下|打开)/;
const ON_NEG = /(不用|不要|别|不需要|尚未|还没|没有|没)\S{0,6}(开启|打开|进入|用)\s*教师模式|教师模式\s*(还没|没有|没|不用|不要)\s*(开启|打开)/;
const OFF_RE = /(关闭|退出|结束|关掉)\s*教师模式|下课/;
const OFF_NEG = /(不|别|先不|暂不)\S{0,4}(关闭|退出|结束|关掉)\s*教师模式|不下课/;

function messageText(msg) {
  const c = msg?.content;
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) {
    return c.filter((p) => p && p.type === 'text' && typeof p.text === 'string').map((p) => p.text).join('\n');
  }
  return '';
}

/** 开课回执码：TM- 加 4 位，去掉容易看混的 O/0/I/1 */
const RECEIPT_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function newReceipt() {
  let s = '';
  for (let i = 0; i < 4; i++) s += RECEIPT_ALPHABET[Math.floor(Math.random() * RECEIPT_ALPHABET.length)];
  return 'TM-' + s;
}

/** 教学大纲体检（v0.10）：返回问题清单，空数组才算合格 */
function checkSyllabusText(text) {
  const t = String(text || '');
  const issues = [];
  const lines = t.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  const micro = (t.match(/微点/g) || []).length;
  if (lines.length < 8) issues.push(`全文只有 ${lines.length} 行，太短，不可能覆盖一门课`);
  if (micro < 6) issues.push(`只出现 ${micro} 处「微点」；最低一级必须叫微点，且要按素材列全`);
  const levels = [
    /第[一二三四五六七八九十百零\d]+章/,
    /第[一二三四五六七八九十百零\d]+节/,
    /^#{2,4}\s/m,
    /^[A-Z]\d{2}\b/m,
    /^[-*]\s/m,
    /^\d+[.、]/m,
  ].filter((re) => re.test(t)).length;
  if (levels < 2) issues.push('看不出两级以上结构（章 / 节 / 微点，或 L01 / 微点）');
  return { issues, lines: lines.length, micro };
}

// 讲授结构词（v0.10 提到模块级：lectureSignal 在模块作用域，引用不到 apply 里的闭包变量）
const LESSON_WHAT = /是什么|什么是|定义|含义|指的是|规则|写法|概念/;
const LESSON_WHY = /为什么|因为|原理|推导|道理|原因/;

/** 题干/选项检查（v0.10）：代码必须放正文，题干只写中文；选项不许泄题 */
const CARD_CODE_LINE = /^\s*(print\s*\(|def\s+\w|class\s+\w|import\s+\w|from\s+\w+\s+import|for\s+.+\s+in\s+|while\s+.+|if\s+.+:|elif\s+.+:|else\s*:|return\s+|>>>|```)/;
function checkCardPayload(args) {
  const qs = args && args.questions;
  if (!Array.isArray(qs)) return '';
  for (const q of qs) {
    const text = String(q?.question || '');
    if (text.includes('```')) return '题干里出现了代码块（三个反引号）——代码必须放在正文代码框里，题干只写中文';
    if (/\r?\n/.test(text)) {
      const lines = text.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
      const codeLines = lines.filter((l) => CARD_CODE_LINE.test(l) || (/\w+\s*=\s*[^=]/.test(l) && !/^[一二三四五六七八九十\d]+[.、]/.test(l)));
      if (codeLines.length) return `题干里塞了多行代码（例如「${codeLines[0].slice(0, 30)}」）——代码放正文代码框，题干用中文指代`;
    }
    if (text.length > 800) return `题干有 ${text.length} 字，太长了，把材料放正文、题干只问一句`;
    const opts = Array.isArray(q?.options) ? q.options : [];
    // 只在「像选择题」的卡片上查暗示：选项 ≥3 或题干是典型题干措辞；
    // 否则管理 / 问询卡片（如「要不要再收紧？」）会被误伤（2026-11-12 实测）。
    const quizLike = opts.length >= 3 || /下列|以下|哪一|哪个|哪项|输出|结果|等于|正确的是|选出|计算/.test(text);
    if (quizLike) {
      for (const o of opts) {
        const label = String(o?.label || '') + ' ' + String(o?.description || '');
        if (/推荐|首选|最佳|最合适/.test(label)) return '选项里写了「推荐/首选/最佳」这类暗示，等于泄题';
      }
    }
  }
  return '';
}

/** 问询/确认型卡片：备课问询、要不要开下一章、选目录格式——这些不该被讲解门禁误伤 */
function isConfirmCard(args) {
  const qs = args && args.questions;
  if (!Array.isArray(qs) || qs.length !== 1) return false;
  const q = qs[0];
  const text = String(q?.question || '');
  const opts = Array.isArray(q?.options) ? q.options : [];
  if (!opts.length || opts.length > 3) return false;
  if (/微点\s*\d|第\s*\d+\s*题|下列说法|正确的是|输出什么|等于多少/.test(text)) return false;
  return /要不要|是否|确认|可以吗|行吗|对吗|好不好|可以开始|开始吗|继续吗|准备好了吗|同意|选哪种|哪个格式/.test(text);
}

/** 讲解信号（v0.10 信号制）：任一强信号成立就算"讲过了" */
function lectureSignal(text) {
  const t = String(text || '');
  const len = t.length;
  const coord = /微点\s*\d+|▍第/.test(t);
  const headings = (t.match(/^###\s+\S/gm) || []).length;
  const hasCode = t.includes('```');
  const hasWhat = LESSON_WHAT.test(t);
  const hasWhy = LESSON_WHY.test(t);
  if (coord) return { ok: true, hit: '坐标行' };
  if (headings >= 2) return { ok: true, hit: `${headings} 个段标题` };
  if (hasCode && len >= 120) return { ok: true, hit: '代码块+120字' };
  if (len >= 300) return { ok: true, hit: '300字正文' };
  if (len >= 150 && hasWhat && hasWhy) return { ok: true, hit: '是什么+为什么' };
  return { ok: false, hit: '无', len, headings, hasCode, hasWhat, hasWhy };
}

/** 阶段闸门（v0.10）：备课/大纲阶段不许出教学内容题；问询卡片放行 */
function phaseGateReason(st, args) {
  if (!st) return '';
  const phase = phaseOf(st);
  if (phase === 'teaching' || phase === 'ready') return '';
  const qs = (args && Array.isArray(args.questions)) ? args.questions : [];
  const looksLesson = qs.some((q) => /微点\s*\d|下列说法|正确的是|输出什么|等于多少|第\s*\d+\s*题/.test(String(q?.question || '')));
  if (!looksLesson) return '';
  const why = phase === 'syllabus' ? '教学大纲还没让学生确认'
    : phase === 'ready' ? '还没调 teaching_start 正式开课'
    : '备课还没完成（课程/教材形态/素材/要求没问齐）';
  return `【教师模式门禁·出题被拒绝】当前阶段是「${PHASE_TEXT[phase] || phase}」，${why}。\n`
    + '这一轮不许出教学内容题。先把开课流程走完：teaching_prepare → 写大纲并 teaching_syllabus → 学生确认后 teaching_start。\n'
    + '如果只是问学生「要不要继续」「选哪种目录格式」「信息对不对」，请用问询型卡片（选项不超过 3 个、不写微点编号）。';
}

/** 距考试还有几天；日期不可解析时返回 null（不猜、不报错） */
function daysUntil(dateStr) {
  const t = Date.parse(String(dateStr || '').trim());
  if (Number.isNaN(t)) return null;
  return Math.ceil((t - Date.now()) / 86400000);
}

/** 构造 /teaching 命令的处理器。状态、路径、默认值全部经参数传入，不依赖外部作用域。 */
function makeTeachingHandler({ store, persist, stateOf, cfg, diag, peersOf, defaultOn }) {
  const ensure = (id) => {
    if (!store.sessions[id]) store.sessions[id] = normalizeState({ on: defaultOn, updatedAt: new Date().toISOString() });
    return store.sessions[id];
  };
  const touch = (st) => { st.updatedAt = new Date().toISOString(); };

  const statusLines = (id, st) => {
    const lines = [`教师模式：${st.on ? '已开启' : '已关闭'}（本会话）`];
    const ph = phaseOf(st);
    lines.push(`- 阶段：${PHASE_TEXT[ph] || ph}${ph === 'teaching' ? '' : '（开课流程还没走完）'}`);
    if (ph === 'ready' && st.receipt) lines.push(`- 开课回执：${st.receipt}（等学生确认后调 teaching_start）`);
    if (st.syllabus) lines.push(`- 教学大纲：${st.syllabus.microCount || '?'} 个微点${st.syllabus.confirmedAt ? '（学生已确认）' : '（待学生确认）'}`);
    lines.push(`- 课题：${st.subject || '未设置'}`);
    lines.push(`- 教材：${st.material || '未设置'}`);
    lines.push(`- 当前章：${st.chapter || '未设置'}`);
    if (st.chapterNote) lines.push(`- 章节备注：${st.chapterNote}`);
    lines.push(`- 当前小节：${st.currentSection || '未设置'}`);
    lines.push(`- 下一小节：${st.nextSection || '未设置'}`);
    lines.push(`- 已讲完的小节：${st.learnedSections.length ? st.learnedSections.join('、') : '无'}`);
    lines.push(`- 已生成教材：${st.generatedChapters.length ? st.generatedChapters.join('、') : '未设置'}`);
    lines.push(`- 已学完的章：${st.learnedChapters.length ? st.learnedChapters.join('、') : '未设置'}`);
    lines.push(`- 下一章：${st.nextChapter || '未设置'}`);
    if (st.examDate || st.examTypes || st.examScope || st.examPapers) {
      const d = daysUntil(st.examDate);
      lines.push(`- 考试：${st.examDate || '日期未设置'}${d === null ? '' : `（还有 ${d} 天）`}`);
      lines.push(`  题型分值：${st.examTypes || '未设置'}`);
      lines.push(`  范围/重点：${st.examScope || '未设置'}`);
      lines.push(`  真题：${st.examPapers || '未设置'}`);
    } else {
      lines.push('- 考试：未设置');
    }
    const openN = openDebts(st).length;
    lines.push(`- 欠账：${openN} 条未销（已销 ${st.debts.filter((d) => d && d.status === 'resolved').length} 条）`);
    lines.push(`- 错题：${st.mistakeStats.total} 道${Object.keys(st.mistakeStats.byLayer).length ? `（${Object.entries(st.mistakeStats.byLayer).map(([k, v]) => `${k}${v}`).join(' / ')}）` : ''}`);
    lines.push(`- 资料落盘目录：${st.dataDir || '未确定（设置课题后自动生成）'}`);
    const peers = peersOf(store, id);
    if (peers.length) lines.push(`- 同课题其它会话：${peers.map((p) => shortId(p.id)).join('、')}`);
    return lines;
  };

  return async function handler(invocation) {
    try {
      const id = invocation?.agent?.id || invocation?.session?.id || '';
      if (!id) return { kind: 'error', text: '拿不到当前会话 id，无法记录教学状态。' };
      const raw = String(invocation?.rawInput || '').trim();
      const argsText = typeof invocation?.args === 'string'
        ? invocation.args
        : Array.isArray(invocation?.args) ? invocation.args.join(' ') : '';
      let rest = raw.replace(/^\s*\/?\s*teaching\b/i, '').trim();
      if (!rest) rest = argsText.trim();
      const verbMatch = rest.match(/^(\S+)/);
      const verb = verbMatch ? verbMatch[1].toLowerCase() : '';
      const tail = rest.slice(verbMatch ? verbMatch[0].length : 0).trim();
      const st = ensure(id);

      const err = (text) => ({ kind: 'error', text });
      const ok = (text) => { touch(st); persist(); return { kind: 'success', text }; };

      switch (verb) {
        case 'on': {
          st.on = true;
          return ok(`教师模式已开启（本会话）：${st.subject ? `课题「${st.subject}」` : '尚未设置课题（用 /teaching setup 设置）'}\n规程已注入：备课先问 → 小知识点各配 1 道卡片例题 → 知识点收口再加 2 道 → 小节出复习资料。\n关闭：/teaching off`);
        }
        case 'off': {
          st.on = false;
          return ok('教师模式已关闭（本会话）。后续按普通对话进行，规程不再注入。');
        }
        case 'reset': {
          store.sessions[id] = normalizeState({ on: false, cwd: st.cwd, updatedAt: new Date().toISOString() });
          persist();
          return { kind: 'success', text: '本会话的教学状态已清空（课题、进度、欠账全部重置）。' };
        }
        case 'setup': {
          if (!tail) return err('用法：/teaching setup <课题> | <教材>\n例：/teaching setup 汇编语言 | 王爽《汇编语言》第四版');
          const [subject, material] = tail.split('|').map((s) => s.trim());
          const bad = tooLong('课题', subject, LIMITS.subject) || (material ? tooLong('教材', material, LIMITS.material) : null);
          if (bad) return err(bad);
          st.subject = subject || '';
          st.material = material || '';
          const dir = deriveDataDir(st.cwd, st.subject);
          if (dir) st.dataDir = dir;
          return ok(`已记录：课题「${st.subject || '-'}」｜教材「${st.material || '-'}」\n资料落盘目录：${st.dataDir || '（未取到本对话工作目录，落盘目录待定）'}`);
        }
        case 'progress': {
          if (!tail) return err('用法：/teaching progress <当前章>\n例：/teaching progress 第8章 8.5 数据有多长');
          const bad = tooLong('当前章', tail, LIMITS.chapter);
          if (bad) return err(bad);
          st.chapter = tail;
          return ok(`当前章已设为「${tail}」。`);
        }
        case 'debt': {
          if (!tail) return err('用法：/teaching debt <欠账内容>');
          if (openDebts(st).length >= LIMITS.debtsMax) return err(`未销欠账已满（${LIMITS.debtsMax} 条）：先复测销账，或把不重要的作废，再记新的。`);
          const bad = tooLong('欠账', tail, LIMITS.debt);
          if (bad) return err(bad);
          const item = pushDebt(st, tail);
          return ok(`欠账已记 #${item.id}（未销 ${openDebts(st).length} 条）：${tail}\n按约定：撞到再补；复测答对后用 debt_resolved 销账，别让它一直躺着。`);
        }
        case 'debts': {
          const open = openDebts(st);
          const resolved = st.debts.filter((d) => d && d.status === 'resolved').length;
          const dropped = st.debts.filter((d) => d && d.status === 'dropped').length;
          const head = `未销 ${open.length} 条｜已销 ${resolved} 条｜作废 ${dropped} 条｜错题 ${st.mistakeStats.total} 道`;
          if (!open.length) return { kind: 'success', text: `${head}\n没有未销欠账。` };
          return {
            kind: 'success',
            text: `${head}\n${open.map((d) => `  #${d.id} ${d.text}`).join('\n')}\n销账：/teaching resolve <编号|关键词>；作废：/teaching drop <编号|关键词>`,
          };
        }
        case 'resolve': {
          if (!tail) return err('用法：/teaching resolve <编号|关键词> [| 备注]');
          const [key, note] = tail.split('|').map((s) => s.trim());
          const d = findDebt(st, key);
          if (!d) return err(`没找到欠账「${key}」。用 /teaching debts 看编号与内容。`);
          if (d.status !== 'open') return err(`欠账 #${d.id} 已是「${DEBT_STATUS_TEXT[d.status] || d.status}」，不用再销。`);
          closeDebt(st, d, 'resolved', note);
          return ok(`已销账 #${d.id}：${d.text}${note ? `（备注：${note}）` : ''}\n未销还剩 ${openDebts(st).length} 条。`);
        }
        case 'drop': {
          if (!tail) return err('用法：/teaching drop <编号|关键词> [| 原因]');
          const [key, note] = tail.split('|').map((s) => s.trim());
          const d = findDebt(st, key);
          if (!d) return err(`没找到欠账「${key}」。用 /teaching debts 看编号与内容。`);
          if (d.status !== 'open') return err(`欠账 #${d.id} 已是「${DEBT_STATUS_TEXT[d.status] || d.status}」。`);
          closeDebt(st, d, 'dropped', note);
          return ok(`已作废 #${d.id}：${d.text}${note ? `（原因：${note}）` : ''}`);
        }
        case 'mistakes': {
          const n = Math.max(1, Math.min(10, Number(tail) || 5));
          if (!st.mistakeStats.total) return { kind: 'success', text: '还没有错题记录（学生答错时调用 teaching_mistake 记下，明细会自动写进错题本.md）。' };
          const layers = Object.entries(st.mistakeStats.byLayer).map(([k, v]) => `${k} ${v}`).join(' / ') || '未分层';
          const rows = st.recentMistakes.slice(0, n).map((m) => `  - ${m.topic || '-'}（${m.layer}）：${m.question || ''}`);
          return { kind: 'success', text: `错题共 ${st.mistakeStats.total} 道｜分层：${layers}\n最近 ${Math.min(n, st.recentMistakes.length)} 条：\n${rows.join('\n')}` };
        }
        case 'review': {
          const open = openDebts(st);
          if (!open.length && !st.mistakeStats.total) return { kind: 'success', text: '没有待复习内容：既没有未销欠账，也没有错题。' };
          const bits = [`### 复习请求${tail ? `（主题：${tail}）` : ''}`];
          if (open.length) bits.push(`未销欠账 ${open.length} 条：\n${open.map((d) => `  #${d.id} ${d.text}`).join('\n')}`);
          if (st.recentMistakes.length) bits.push(`最近错题：\n${st.recentMistakes.slice(0, 5).map((m) => `  - ${m.topic || '-'}（${m.layer}）：${m.question || ''}`).join('\n')}`);
          bits.push('出题要求：先复测欠账对应的小知识点（换题型，不要照抄原题）；再按最近错题补 3 道同类题；答对后调 teaching_update 的 debt_resolved 销账，答错调 teaching_mistake 记一条。');
          return { kind: 'success', text: bits.join('\n') };
        }
        case 'done': {
          if (!tail) return err('用法：/teaching done <已讲完内容>');
          if (!st.finished.includes(tail)) st.finished.push(tail);
          return ok(`已记录讲完：「${tail}」（共 ${st.finished.length} 项）。`);
        }
        case 'section': {
          if (!tail) return err('用法：/teaching section <当前小节>\n例：/teaching section 1.2 介绍自己');
          const bad = tooLong('当前小节', tail, LIMITS.section);
          if (bad) return err(bad);
          st.currentSection = tail;
          return ok(`当前小节已设为「${tail}」。`);
        }
        case 'next-section': {
          if (!tail) return err('用法：/teaching next-section <下一小节>');
          const bad = tooLong('下一小节', tail, LIMITS.section);
          if (bad) return err(bad);
          st.nextSection = tail;
          if (!st.currentSection) st.currentSection = tail;
          healState(st);
          return ok(`下一小节已设为「${tail}」。`);
        }
        case 'learn-section': {
          if (!tail) return err('用法：/teaching learn-section <刚讲完的小节>');
          if (!st.learnedSections.includes(tail)) st.learnedSections.push(tail);
          if (st.currentSection === tail) st.currentSection = '';
          healState(st);
          return ok(`已标记讲完「${tail}」。累计 ${st.learnedSections.length} 个小节：${st.learnedSections.join('、')}`);
        }
        case 'finish-section': {
          const [finished, next] = tail.split('|').map((s) => s.trim());
          if (!finished) return err('用法：/teaching finish-section <刚讲完的小节> | <下一小节>\n例：/teaching finish-section 2.4 s和es的读音 | 2.5 写作');
          const bad = tooLong('小节', finished, LIMITS.section) || (next ? tooLong('下一小节', next, LIMITS.section) : null);
          if (bad) return err(bad);
          if (!st.learnedSections.includes(finished)) st.learnedSections.push(finished);
          const target = next || st.nextSection || '';
          st.currentSection = target && !sameSection(target, finished) ? target : '';
          st.nextSection = '';
          const lines = [`已标记讲完「${finished}」（累计 ${st.learnedSections.length} 小节）。`];
          if (st.currentSection) lines.push(`当前小节已自动切到「${st.currentSection}」，可以直接开讲。`);
          else lines.push('当前小节已清空：下一节确定后，用 finished_section + next_section 一起传过来。');
          return ok(lines.join('\n'));
        }
        case 'finish-chapter': {
          let force = false;
          let restCh = tail;
          if (/(^|\s)--force\b/i.test(restCh)) { force = true; restCh = restCh.replace(/(^|\s)--force\b/gi, ' ').trim(); }
          const [chapter, next] = restCh.split('|').map((s) => s.trim());
          if (!chapter) return err('用法：/teaching finish-chapter <整章学完> | <下一章> [--force]\n例：/teaching finish-chapter 第2章 | 第3章');
          const bad = tooLong('章名', chapter, LIMITS.chapter) || (next ? tooLong('下一章', next, LIMITS.chapter) : null);
          if (bad) return err(bad);
          const review = hasChapterReview(st, chapter);
          if (review === false && !force) {
            return err(`先别收章：资料目录里没有「${chapterNo(chapter) ? `第${chapterNo(chapter)}章` : chapter}-总复习.md」。\n`
              + '按规矩，整章讲完要把各小节复习资料合并成整章总复习再收章。\n'
              + '写好后重试；确实不要总复习，用 /teaching finish-chapter ' + chapter + ' --force');
          }
          if (!st.learnedChapters.includes(chapter)) st.learnedChapters.push(chapter);
          st.currentSection = '';
          st.nextSection = '';
          if (next) st.nextChapter = next;
          const text = `已标记学完「${chapter}」（累计 ${st.learnedChapters.length} 章），小节进度已清空。`
            + (review ? '\n已确认总复习文件存在。' : '\n（没有资料落盘目录，无法校验总复习文件，请自行确认。）')
            + (review === false ? '\n（force：跳过了总复习检查。）' : '')
            + (st.nextChapter
              ? `\n下一章：「${st.nextChapter}」——按规矩先只生成这一章，再问学生要不要开讲。`
              : '\n还没有下一章记录：先确认下一章是什么，再生成（一次只生成一章）。');
          return ok(text);
        }
        case 'index': {
          const file = rebuildIndex(st);
          if (!file) return err('还没有资料落盘目录（先 /teaching setup 设置课题），无法建索引。');
          return ok(`课程索引已重建：${file}`);
        }
        case 'gen': {
          if (!tail) return err('用法：/teaching gen <已生成教材的章>\n例：/teaching gen 第2章');
          const bad = tooLong('章名', tail, LIMITS.chapter);
          if (bad) return err(bad);
          if (!st.generatedChapters.includes(tail)) st.generatedChapters.push(tail);
          return ok(`已记录「${tail}」教材已生成。共 ${st.generatedChapters.length} 章：${st.generatedChapters.join('、')}`);
        }
        case 'learn': {
          if (!tail) return err('用法：/teaching learn <已学完的章>\n例：/teaching learn 第2章');
          const bad = tooLong('章名', tail, LIMITS.chapter);
          if (bad) return err(bad);
          if (!st.learnedChapters.includes(tail)) st.learnedChapters.push(tail);
          return ok(`已标记学完「${tail}」。共 ${st.learnedChapters.length} 章：${st.learnedChapters.join('、')}\n该学下一章了：请说「继续」，我会先只生成下一章。`);
        }
        case 'next': {
          if (!tail) return err('用法：/teaching next <下一章>');
          const bad = tooLong('下一章', tail, LIMITS.chapter);
          if (bad) return err(bad);
          st.nextChapter = tail;
          return ok(`下一章已设为「${tail}」。学到当前章末尾时会先只生成这一章，不越到更后面。`);
        }
        case 'exam': {
          if (!tail) {
            const d = daysUntil(st.examDate);
            const lines = [
              '当前考试信息：',
              `  日期：${st.examDate || '未设置'}${d === null ? '' : `（还有 ${d} 天）`}`,
              `  题型分值：${st.examTypes || '未设置'}`,
              `  范围/重点：${st.examScope || '未设置'}`,
              `  真题：${st.examPapers || '未设置'}`,
              '用法：/teaching exam <日期> | <题型分值> | <范围> | <真题>',
              '例：/teaching exam 2026-01-10 | 选择20+简答30+计算50 | 第1-5章，第3章最重 | 历年5套，2套带答案',
            ];
            return { kind: 'success', text: lines.join('\n') };
          }
          const parts = tail.split('|').map((s) => s.trim());
          if (parts[0]) st.examDate = parts[0];
          if (parts[1]) st.examTypes = parts[1];
          if (parts[2]) st.examScope = parts[2];
          if (parts[3]) st.examPapers = parts[3];
          const d = daysUntil(st.examDate);
          return ok(`已记录考试信息：日期「${st.examDate || '-'}」${d === null ? '' : `（还有 ${d} 天）`}｜题型「${st.examTypes || '-'}」｜范围「${st.examScope || '-'}」｜真题「${st.examPapers || '-'}」`);
        }
        case 'repair': {
          const fixed = [];
          for (const [sid, s] of Object.entries(store.sessions)) {
            const bits = [];
            if (healState(s)) bits.push('清掉陈旧的当前/下一小节');
            if (splitChapter(s)) bits.push('章名拆成短名+备注');
            if (bits.length) { s.updatedAt = new Date().toISOString(); fixed.push(`${shortId(sid)}：${bits.join('；')}`); }
          }
          if (!fixed.length) return { kind: 'success', text: '没有需要修复的会话（状态已经是干净的）。' };
          persist();
          return { kind: 'success', text: `已修复 ${fixed.length} 个会话：\n${fixed.join('\n')}` };
        }
        case 'courses': {
          const groups = courseGroups(store);
          if (!groups.size) return { kind: 'success', text: '还没有任何课程记录（用 /teaching setup 或直接开始上课）。' };
          const lines = [];
          for (const [, list] of groups) {
            const withSubject = list.find((x) => x.st.subject);
            const withChapter = [...list].reverse().find((x) => x.st.chapter);
            const ids = list.map((x) => `${shortId(x.id)}${x.st.on ? '*' : ''}`).join('、');
            lines.push(`- 「${withSubject ? withSubject.st.subject : '（未命名）'}」：${withChapter ? withChapter.st.chapter : '（未设置进度）'}\n  会话：${ids}`);
          }
          return { kind: 'success', text: ['课程列表（* = 该会话开着教师模式，进度已自动合并）：', ...lines].join('\n') };
        }
        case 'prune': {
          // 清理空壳会话记录（2026-11-03）：既没课题、也没资料目录、也没任何进度/欠账/错题，
          // 却一直占着 /teaching courses 与面板的行——60 多条垃圾记录就是这么攒出来的。
          const gone = [];
          for (const [sid, s] of Object.entries(store.sessions)) {
            if (!s || typeof s !== 'object') { gone.push(sid); continue; }
            if (s.subject || s.dataDir) continue;
            const empty = !(Array.isArray(s.learnedSections) && s.learnedSections.length)
              && !(Array.isArray(s.debts) && s.debts.length)
              && !(Array.isArray(s.recentMistakes) && s.recentMistakes.length)
              && !(Array.isArray(s.finished) && s.finished.length)
              && !(Array.isArray(s.learnedChapters) && s.learnedChapters.length);
            if (empty) gone.push(sid);
          }
          if (!gone.length) return { kind: 'success', text: '没有空壳会话记录，状态库是干净的。' };
          if (!/^\s*(-f|--force|yes|确认)\s*$/.test(tail || '')) {
            return { kind: 'success', text: [`将清理 ${gone.length} 条空壳会话（课题/目录/进度/欠账/错题全空）：`, gone.map((x) => '  ' + shortId(x)).join('\n'), '', '确认无误后执行：/teaching prune -f'].join('\n') };
          }
          for (const sid of gone) delete store.sessions[sid];
          persist();
          return { kind: 'success', text: `已清理 ${gone.length} 条空壳会话记录。剩余 ${Object.keys(store.sessions).length} 条。` };
        }
        case 'link': {
          if (!tail) return err('用法：/teaching link <其它会话 id 的前 8 位>（先 /teaching courses 查看）');
          const bare = (s) => String(s == null ? '' : s).replace(/^session-/, '');
          const hit = Object.entries(store.sessions).find(([sid]) => sid === tail || bare(sid) === tail || bare(sid).startsWith(tail));
          if (!hit) return err(`没找到以「${tail}」开头的会话。`);
          const [otherId, other] = hit;
          if (otherId === id) return err('不能 link 自己。');
          for (const f of COURSE_FIELDS) {
            if (other[f] !== undefined) st[f] = Array.isArray(other[f]) ? [...other[f]] : other[f];
          }
          touch(st);
          persist();
          return { kind: 'success', text: `已挂到会话 ${shortId(otherId)} 的课程：「${st.subject || '-'}」：进度「${st.chapter || '-'}」，已讲完 ${(st.learnedSections || []).length} 个小节，欠账 ${(st.debts || []).length} 条。以后两边进度自动合并。` };
        }
        case 'status':
        case 'help':
        case '':
          return { kind: 'success', text: statusLines(id, st).join('\n') };
        default:
          return { kind: 'success', text: statusLines(id, st).join('\n') };
      }
    } catch (e) {
      diag('command-failed ' + (e && e.stack ? e.stack : String(e)));
      return { kind: 'error', text: '执行失败：' + (e && e.message ? e.message : String(e)) };
    }
  };
}

// ── 模型工具：让 AI 自己记状态，学生不用敲命令 ──

/** 拼一个 DSH 工具定义：参数用"字段表"写，产出标准 JSON Schema */
function makeTool({ name: toolName, description, fields = {}, run }) {
  const properties = {};
  const required = [];
  for (const [key, f] of Object.entries(fields)) {
    properties[key] = { type: f.type === 'boolean' ? 'boolean' : f.type === 'number' ? 'number' : 'string', description: f.description };
    if (f.required) required.push(key);
  }
  return {
    name: toolName,
    description,
    parameters: { type: 'object', properties, required, additionalProperties: false },
    // render 必须返回 content 块数组，且第一个参数是工具入参、第二个才是执行结果：
    // 宿主 dsh-tools/lib/index.js 调 render(exec.arguments, value)，并会对返回的 content 调 .some()。
    output: { schema: { type: 'string' }, render: (_args, v) => [{ type: 'text', text: String(v) }] },
    isConcurrencySafe: () => false,
    execute: async (args, execCtx) => run(args && typeof args === 'object' ? args : {}, execCtx || {}),
  };
}

function buildTools({ store, persist, stateOf, cfg, diag, peersOf, deriveDataDir: derive, tooLong: bad, LIMITS: lim, ensureDataDir: ensureDir }) {
  const ensure = (id) => {
    if (!store.sessions[id]) store.sessions[id] = normalizeState({ on: false, updatedAt: new Date().toISOString() });
    return store.sessions[id];
  };
  const touch = (st) => { st.updatedAt = new Date().toISOString(); };
  const idOf = (execCtx) => execCtx?.agent?.id || execCtx?.session?.id || '';

  return [
    makeTool({
      name: 'teaching_setup',
      description: '记录这门课的课题与教材（学生说了学什么、用什么材料时调用），并自动确定讲义落盘目录。',
      fields: {
        subject: { required: true, description: '课题，如「模式识别」「汇编语言」' },
        material: { description: '教材/材料说明，如「吴保俊 9章PPT」「王爽《汇编语言》第四版」' },
        material_mode: { description: '教材形态：textbook=有现成/已编好的成体系教材；outline=只有素材、只出教学大纲（学生更省时间时优先 outline）' },
        requirements: { description: '学生对这门课的要求（考试目标、进度、讲法偏好），≤300 字' },
      },
      run: (args, execCtx) => {
        const id = idOf(execCtx);
        if (!id) return '拿不到会话 id，未做修改。';
        const subject = String(args.subject || '').trim();
        const material = String(args.material || '').trim();
        const e = bad('课题', subject, lim.subject) || (material ? bad('教材', material, lim.material) : null);
        if (e) return e;
        if (!subject) return '未提供课题，未做任何修改。';
        const st = ensure(id);
        const prevSubject = st.subject || '';
        const subjectChanged = prevSubject !== subject;
        st.subject = subject;
        if (material) st.material = material;
        const mode = String(args.material_mode || '').trim();
        if (mode) {
          if (mode !== 'textbook' && mode !== 'outline') return 'material_mode 只能是 textbook 或 outline。';
          st.materialMode = mode;
        }
        const req = String(args.requirements || '').trim();
        if (req) {
          const e2 = bad('学生要求', req, lim.requirements);
          if (e2) return e2;
          st.requirements = req;
        }
        const cwd = st.cwd || execCtx?.header?.cwd || '';
        const dir = derive(cwd, subject);
        let reused = '';
        if (dir) {
          // 接力保护：课题名被改写（上册→下册、多加了括号注释）时，别另建空目录把历史进度甩掉
          const guess = suggestDataDir(cwd, subject);
          if (guess && path.resolve(guess) !== path.resolve(dir)) {
            st.dataDir = guess;
            reused = `\n\n♻ 本工作区已有同一门课的资料目录，已自动沿用、不另建新目录：${guess}`;
          } else {
            st.dataDir = dir;
          }
        }
        // 新课 / 换了课题 → 备课闸门关上；但「同一门课换个叫法」不算换课，不重置备课结论
        if (subjectChanged && normSubject(prevSubject) !== normSubject(subject)) st.prep = 'pending';
        // v0.10：新课显式进 briefing 阶段（phase='' 的旧状态仍按进度推导，老课不受影响）
        if (!st.phase && (subjectChanged || !st.startedAt)) st.phase = 'briefing';
        touch(st);
        persist();
        const gate = st.prep === 'pending'
          ? '\n\n⛔ 备课闸门已关上：先问清四项再开讲——① 教材到手没有、目录页码齐不齐、缺哪些；② 有没有历年真题/试卷、几套、带不带答案；③ 这门课按什么路线走（章→节→知识点大纲，等学生确认）；④ 考试日期/题型分值/范围。落实后调用 teaching_prepare（confirmed: true）。'
          : '';
        const modeText = st.materialMode === 'textbook' ? '现成教材' : st.materialMode === 'outline' ? '只有素材（只出大纲）' : '未问';
        const next = st.phase === 'briefing'
          ? '\n\n下一步（开课流程，不许跳）：先问学生三件事——① 教材形态：有现成/已编好的成体系教材（textbook），还是只有素材、只出教学大纲（outline）？② 具体要求：考试目标、进度、讲法偏好；③ 目录格式选哪种（第X章/第Y节/微点N 三级、L01 讲次/微点 两级、或自定义）。问完用 teaching_prepare 确认备课。'
          : '';
        return `已记录课题「${st.subject}」${st.material ? `｜教材「${st.material}」` : ''}｜教材形态：${modeText}${st.requirements ? `｜要求：${st.requirements}` : ''}\n资料落盘目录：${st.dataDir || '（未取到本对话工作目录，落盘目录待定）'}${reused}${gate}${next}`;
      },
    }),
    makeTool({
      name: 'teaching_prepare',
      description: '备课闸门：教材整理（目录/页码/缺页）、教学路线（章节大纲）、真题试卷情况、考试信息四项都落实后调用，confirmed=true 才允许开始讲解。开课前没备完课会一直拦着，不许讲知识点、不许出题。',
      fields: {
        confirmed: { type: 'boolean', required: true, description: '备课是否已完成（四项都落实：教材齐不齐 / 真题几套带不带答案 / 章节目录大纲 / 考试日期题型范围）' },
        note: { description: '备课结论摘要（选填，如「教材齐全；真题3套含答案；路线已确认；考试1月10日，选择20+简答30+计算50」），会写进资料目录的 备课记录.md' },
      },
      run: (args, execCtx) => {
        const id = idOf(execCtx);
        if (!id) return '拿不到会话 id，未做修改。';
        const st = ensure(id);
        if (!st.subject) return '还没记课题：先调用 teaching_setup 记下课题与教材，再来备课。';
        const note = String(args.note || '').trim();
        if (args.confirmed === true) {
          const gaps = briefGapsOf(st);
          if (gaps.length) {
            return '备课还不能确认，先补齐：' + gaps.join('；') + '。\n'
              + '（教材形态必须问清：textbook=有现成/已编好的成体系教材；outline=只有素材、只出教学大纲。两种都算备课，但不能空着。）';
          }
          st.prep = 'confirmed';
          st.phase = st.syllabus ? 'ready' : 'syllabus';
          touch(st);
          persist();
          if (note && st.dataDir) {
            try { fs.writeFileSync(path.join(st.dataDir, '备课记录.md'), `# 备课记录\n\n更新时间：${new Date().toISOString()}\n\n${note}\n`, 'utf8'); } catch { /* 落盘失败不影响状态 */ }
          }
          return `✅ 备课已完成，闸门打开。下一步不是讲课，是写教学大纲：\n1) 按学生选的格式编写大纲全文（最低一级必须叫「微点」，按素材列全）；\n2) 调 teaching_syllabus（content + mode）交体检；\n3) 学生明确同意后再调 teaching_syllabus（confirmed: true）生成开课回执码。${note ? `\n备课结论：${note}` : ''}`;
        }
        st.prep = 'pending';
        touch(st);
        persist();
        return `⛔ 备课未完成，闸门关闭：这一轮不许讲知识点、不许出题。把四项问清——① 教材目录/页码/缺页；② 真题几套带不带答案；③ 章→节→知识点路线；④ 考试日期/题型分值/范围。`;
      },
    }),
    makeTool({
      name: 'teaching_syllabus',
      description: '提交教学大纲：先按学生选的格式把大纲全文写进 content（最低一级必须叫「微点」，按素材列全），插件会体检；学生明确同意后再调一次并带 confirmed=true，生成开课回执码。没确认前不要带 confirmed。',
      fields: {
        content: { required: true, description: '教学大纲全文（Markdown），按学生选的格式分级，最低一级叫微点' },
        mode: { description: '目录格式：chapter=第X章/第Y节/微点N；L=L01 讲次/微点；custom=自定义（学生指定的格式）' },
        confirmed: { type: 'boolean', description: '学生是否已经明确同意这份大纲（同意才 true）' },
        force: { type: 'boolean', description: '体检不通过、但学生坚持要这份大纲时才带 true' },
      },
      run: (args, execCtx) => {
        const id = idOf(execCtx);
        if (!id) return '拿不到会话 id，未做修改。';
        const st = ensure(id);
        if (!st.subject) return '还没记课题：先 teaching_setup。';
        const content = String(args.content || '').trim();
        if (!content) return 'content 为空，未做修改。';
        const e = bad('教学大纲', content, lim.syllabusText);
        if (e) return e;
        const mode = String(args.mode || '').trim();
        if (mode && !['chapter', 'L', 'custom'].includes(mode)) return 'mode 只能是 chapter / L / custom。';
        const check = checkSyllabusText(content);
        if (check.issues.length && !args.force) {
          return '大纲体检没过，先改：\n- ' + check.issues.join('\n- ') + '\n（确实要提交，带 force: true）';
        }
        let file = st.syllabus && st.syllabus.path ? st.syllabus.path : '';
        if (st.dataDir) {
          try {
            fs.mkdirSync(st.dataDir, { recursive: true });
            file = path.join(st.dataDir, '教学大纲.md');
            writeAtomic(file, content + '\n');
          } catch (err) { return '写教学大纲失败：' + (err && err.message ? err.message : String(err)); }
        }
        st.syllabus = {
          mode: mode || (st.syllabus && st.syllabus.mode) || 'chapter',
          path: file,
          microCount: check.micro,
          lineCount: check.lines,
          confirmedAt: '',
        };
        touch(st);
        persist();
        const head = `已收下教学大纲（${check.lines} 行、${check.micro} 处「微点」）${file ? `，已写到：${file}` : ''}。`;
        if (args.confirmed !== true) {
          return head + '\n体检通过。请把大纲重点列给学生看（分几级、共几个微点、怎么排），明确问一句「这份大纲可以吗？要不要改格式/增删内容」，等学生说同意再调 teaching_syllabus（confirmed: true）。';
        }
        if (phaseOf(st) !== 'syllabus') {
          return head + `\n但当前阶段是「${PHASE_TEXT[phaseOf(st)] || phaseOf(st)}」，不在待确认大纲，先走完 teaching_prepare。`;
        }
        st.syllabus.confirmedAt = new Date().toISOString();
        st.receipt = newReceipt();
        st.phase = 'ready';
        touch(st);
        persist();
        return head + `\n✅ 学生已确认大纲。开课回执码：${st.receipt}\n下一步必须调 teaching_start（receipt: ${st.receipt}）才算正式开课。没走完这一步，不许讲课、不许出题。`;
      },
    }),
    makeTool({
      name: 'teaching_start',
      description: '正式开课：学生把回执码念给你之后调用，receipt 必须与状态里的一致。开课成功后阶段变 teaching，才允许讲课与出题。',
      fields: { receipt: { required: true, description: '学生确认大纲后收到的回执码，形如 TM-AB12' } },
      run: (args, execCtx) => {
        const id = idOf(execCtx);
        if (!id) return '拿不到会话 id，未做修改。';
        const st = ensure(id);
        const got = String(args.receipt || '').trim().toUpperCase();
        if (!st.receipt) return '还没有回执码：先 teaching_syllabus 交大纲、学生确认后带 confirmed: true 生成回执。';
        if (!got) return 'receipt 不能为空。';
        if (got !== st.receipt) return `回执码不对（收到 ${got}，应为 ${st.receipt}）。请让学生核对后重试；不要猜、不要绕过。`;
        st.phase = 'teaching';
        st.startedAt = st.startedAt || new Date().toISOString();
        st.on = true;
        touch(st);
        persist();
        return `✅ 正式开课：${st.subject}。阶段=teaching，可以按大纲讲第一个微点了。\n每讲完一个微点：先出 1 道卡片选择题（题干只写中文、代码放正文代码框），再给精简版标准回答。`;
      },
    }),
    makeTool({
      name: 'teaching_update',
      description: '更新教学进度：讲完一个小节传 finished_section + next_section（当前小节会自动切到下一节，不用再单独调一次）；整章讲完传 finished_chapter + next_chapter；生成了教材传 generated_chapter；学生说“这个我没懂”传 debt；复测答对传 debt_resolved 销账（编号或关键词）；记错了要作废传 debt_dropped。讲完一小节、学完一章、销账、学生给出进度时都要调用。',
      fields: {
        finished_section: { description: '刚讲完的小节（会记入已学清单，并把当前小节自动切到 next_section）' },
        next_section: { description: '下一小节（讲完当前小节后接它）' },
        current_section: { description: '当前正在讲的小节' },
        learned_section: { description: '刚讲完的小节（旧参数名，等价于 finished_section）' },
        progress: { description: '当前章名，如「第2章 Unit 2 Hobbies」——只写章名，不要塞叙述' },
        finished_chapter: { description: '整章学完的章，如「第5章」（会清空当前/下一小节并记入学完清单）' },
        generated_chapter: { description: '已生成教材的章，如「第2章」' },
        next_chapter: { description: '下一章，如「第6章」' },
        debt: { description: '要记下来的一条欠账（学生没听懂、需要之后补的点）' },
        debt_resolved: { description: '已补上的欠账：传编号（如 3）或关键词，答对复测后销账' },
        debt_dropped: { description: '作废的欠账：传编号或关键词（比如发现记错了、或这条已经不需要）' },
        debt_note: { description: '销账/作废的备注（选填，如「复测答对，句子改对了」）' },
        force: { type: 'boolean', description: '收章时强制跳过「章末总复习文件必须存在」的检查（确实不需要总复习时才用）' },
      },
      run: (args, execCtx) => {
        const id = idOf(execCtx);
        if (!id) return '拿不到会话 id，未做修改。';
        const st = ensure(id);
        const out = [];
        const finished = String(args.finished_section || args.learned_section || '').trim();
        const nextSec = String(args.next_section || '').trim();
        const curSec = String(args.current_section || '').trim();
        const progress = String(args.progress || '').trim();
        const finCh = String(args.finished_chapter || '').trim();
        const genCh = String(args.generated_chapter || '').trim();
        const nextCh = String(args.next_chapter || '').trim();
        const debt = String(args.debt || '').trim();

        if (curSec) {
          const e = bad('当前小节', curSec, lim.section);
          if (e) return e;
          st.currentSection = curSec;
          out.push(`当前小节：${curSec}`);
        }
        if (finished) {
          const e = bad('小节', finished, lim.section);
          if (e) return e;
          // v0.10：小节讲完必须有该节复习资料落盘，否则不许记「讲完」
          if (st.dataDir && !args.force) {
            const safe = String(finished).replace(/[\\/:*?"<>|]/g, '-').replace(/\s+/g, ' ').trim().slice(0, 80);
            const file = path.join(st.dataDir, `${safe}-复习资料.md`);
            if (!fs.existsSync(file)) {
              return `先别记「讲完」：资料目录里没有「${safe}-复习资料.md」。\n`
                + '一个小节讲完，要把该节知识点总结/例题/易错点写成复习资料再记账；写好重试。确实不需要，就再调一次并带 force: true。';
            }
          }
          if (!st.learnedSections.includes(finished)) st.learnedSections.push(finished);
          out.push(`讲完：${finished}`);
          if (!args.learned_section || args.finished_section) {
            // 新语义：讲完一节自动推进到下一节
            st.currentSection = nextSec && !sameSection(nextSec, finished) ? nextSec : '';
            st.nextSection = '';
            if (st.currentSection) out.push(`当前小节自动切到：${st.currentSection}`);
          }
        }
        if (nextSec && args.finished_section) {
          // 已在上面处理（作为自动推进目标）
        } else if (nextSec) {
          const e = bad('下一小节', nextSec, lim.section);
          if (e) return e;
          st.nextSection = nextSec;
          if (!st.currentSection) st.currentSection = nextSec;
          out.push(`下一小节：${nextSec}`);
        }
        if (progress) {
          const e = bad('当前章', progress, lim.chapter);
          if (e) return e;
          st.chapter = progress;
          out.push(`当前章：${progress}`);
        }
        if (finCh) {
          const e = bad('章名', finCh, lim.chapter);
          if (e) return e;
          const review = hasChapterReview(st, finCh);
          if (review === false && !args.force) {
            return `先别收章：资料目录里没有「${chapterNo(finCh) ? `第${chapterNo(finCh)}章` : finCh}-总复习.md」。\n`
              + '整章讲完要先把各小节复习资料合并成整章总复习再收章；写好后重试。确实不要总复习，就再调一次并带 force: true。';
          }
          if (!st.learnedChapters.includes(finCh)) st.learnedChapters.push(finCh);
          st.currentSection = '';
          st.nextSection = '';
          out.push(`学完一章：${finCh}（小节进度已清空）`);
          if (review) out.push('已确认章末总复习文件存在');
          else if (review === false) out.push('force：跳过了章末总复习检查');
          else out.push('没有资料落盘目录，无法校验总复习文件');
        }
        if (genCh) {
          const e = bad('章名', genCh, lim.chapter);
          if (e) return e;
          if (!st.generatedChapters.includes(genCh)) st.generatedChapters.push(genCh);
          out.push(`已生成教材：${genCh}`);
        }
        if (nextCh) {
          const e = bad('下一章', nextCh, lim.chapter);
          if (e) return e;
          st.nextChapter = nextCh;
          out.push(`下一章：${nextCh}`);
        }
        if (debt) {
          if (openDebts(st).length >= lim.debtsMax) return `未销欠账已满（${lim.debtsMax} 条）：先复测销账，或作废不重要的再记。`;
          const e = bad('欠账', debt, lim.debt);
          if (e) return e;
          const item = pushDebt(st, debt);
          out.push(`欠账 #${item.id}：${debt}`);
        }
        const resKey = String(args.debt_resolved || '').trim();
        if (resKey) {
          const d = findDebt(st, resKey);
          if (!d) return `没找到欠账「${resKey}」，未做修改。`;
          if (d.status !== 'open') return `欠账 #${d.id} 已是「${DEBT_STATUS_TEXT[d.status] || d.status}」，未做修改。`;
          closeDebt(st, d, 'resolved', String(args.debt_note || '').trim());
          out.push(`已销账 #${d.id}：${d.text}`);
        }
        const dropKey = String(args.debt_dropped || '').trim();
        if (dropKey) {
          const d = findDebt(st, dropKey);
          if (!d) return `没找到欠账「${dropKey}」，未做修改。`;
          if (d.status !== 'open') return `欠账 #${d.id} 已是「${DEBT_STATUS_TEXT[d.status] || d.status}」，未做修改。`;
          closeDebt(st, d, 'dropped', String(args.debt_note || '').trim());
          out.push(`已作废 #${d.id}：${d.text}`);
        }
        healState(st);
        if (!out.length) return '没有需要更新的字段。';
        touch(st);
        persist();
        // 备课没完成就记进度 = 边讲边欠账。不拦（用户可能中途才开启），但每次记账都提醒一次
        const gateWarn = prepStateOf(st) === 'pending'
          ? '\n\n⚠️ 这门课还没完成备课（教材整理 / 教学路线 / 试卷情况）。开讲前先补齐，补完调 teaching_prepare（confirmed: true）。'
          : '';
        return out.join('\n') + gateWarn;
      },
    }),
    makeTool({
      name: 'teaching_exam',
      description: '记录考试信息：考试日期、题型与分值、考试范围、手上有几套真题。备课时问到这四项时调用。',
      fields: {
        date: { description: '考试日期，如 2026-01-10' },
        types: { description: '题型与分值，如「选择20+简答30+计算50」' },
        scope: { description: '考试范围/老师划的重点' },
        papers: { description: '真题情况，如「历年5套，2套带答案」' },
      },
      run: (args, execCtx) => {
        const id = idOf(execCtx);
        if (!id) return '拿不到会话 id，未做修改。';
        const st = ensure(id);
        const parts = [args.date, args.types, args.scope, args.papers].map((v) => String(v || '').trim());
        if (!parts.some(Boolean)) return '没有提供任何考试信息。';
        if (parts[0]) st.examDate = parts[0];
        if (parts[1]) st.examTypes = parts[1];
        if (parts[2]) st.examScope = parts[2];
        if (parts[3]) st.examPapers = parts[3];
        touch(st);
        persist();
        const d = daysUntil(st.examDate);
        return `已记录考试信息：日期「${st.examDate || '-'}」${d === null ? '' : `（还有 ${d} 天）`}｜题型「${st.examTypes || '-'}」｜范围「${st.examScope || '-'}」｜真题「${st.examPapers || '-'}」`;
      },
    }),
    makeTool({
      name: 'teaching_mistake',
      description: '记一条错题：学生答错时调用。layer 要指出错在哪一层（概念/推理/记法/计算/粗心）——错层比错题数更重要。明细自动追加到资料落盘目录的 错题本.md。',
      fields: {
        topic: { description: '知识点，如「第三人称单数 -es」或「if 嵌套分支」' },
        question: { description: '题目原文（简短）' },
        my_answer: { description: '学生的答案' },
        correct: { description: '正确答案' },
        cause: { description: '错因（一句话，如「把特殊疑问句当一般疑问句」）' },
        layer: { description: '错在哪一层：概念 / 推理 / 记法 / 计算 / 粗心' },
      },
      run: (args, execCtx) => {
        const id = idOf(execCtx);
        if (!id) return '拿不到会话 id，未记录。';
        const st = ensure(id);
        const topic = String(args.topic || '').trim();
        const question = String(args.question || '').trim();
        if (!topic && !question) return '至少提供 topic 或 question，否则记不下来。';
        const m = {
          topic: topic.slice(0, 40),
          question,
          myAnswer: String(args.my_answer || '').trim(),
          correct: String(args.correct || '').trim(),
          cause: String(args.cause || '').trim(),
          layer: String(args.layer || '').trim(),
        };
        addMistake(st, m);
        const file = writeMistakeNote(st, m);
        touch(st);
        persist();
        const layerText = m.layer && MISTAKE_LAYERS.includes(m.layer) ? m.layer : '未分层';
        let warn = '';
        if (file) {
          try {
            const rows = (fs.readFileSync(file, 'utf8').match(/^\| \d{4}-/gm) || []).length;
            if (rows < st.mistakeStats.total) {
              warn = `\n⚠️ 错题本只找到 ${rows} 行，状态里记着 ${st.mistakeStats.total} 条——文件可能被整份覆盖过。以后只准用 teaching_mistake 追加，不要手写覆盖整份错题本。`;
            }
          } catch { /* 读不了就算了 */ }
        }
        return `已记错题（${layerText}）：${m.topic || m.question}${file ? `\n明细已追加：${file}` : '\n（还没有资料落盘目录，暂只记在状态里）'}${warn}`;
      },
    }),
    makeTool({
      name: 'teaching_note_path',
      description: '查询本会话的资料落盘目录（讲义与复习资料写到哪里）。准备写讲义前调用一次，拿到确切路径。',
      fields: {},
      run: (_args, execCtx) => {
        const id = idOf(execCtx);
        if (!id) return '拿不到会话 id。';
        const st = store.sessions[id];
        if (!st) return '本会话还没有教学状态：先调用 teaching_setup 记录课题。';
        const cwd = st.cwd || execCtx?.header?.cwd || '';
        if (ensureDir(st, cwd)) persist();
        if (!st.dataDir) return '还没有资料落盘目录：先设置课题（teaching_setup），或告诉我本对话的工作目录。';
        // v0.10：目录可能只存在于状态里（ensureDataDir 只"采用已存在目录"），这里真建出来
        try { fs.mkdirSync(st.dataDir, { recursive: true }); } catch (err) {
          return '资料目录存在但不可写：' + st.dataDir + '（' + (err && err.message ? err.message : String(err)) + '）';
        }
        return st.dataDir;
      },
    }),
    makeTool({
      name: 'teaching_toggle',
      description: '开启/关闭教师模式。学生要求开启时必须调用本工具，不能口头宣称已开启；返回值就是要对学生说的回执。',
      fields: { on: { type: 'boolean', required: true, description: 'true=开启，false=关闭' } },
      run: (args, execCtx) => {
        const id = idOf(execCtx);
        if (!id) return '拿不到会话 id，未做修改。';
        const st = ensure(id);
        st.on = args.on === true;
        if (st.on) {
          if (!st.phase && st.subject) st.phase = 'briefing';
          touch(st);
          persist();
          return `✅ 教师模式已开启（state: on=true，会话 ${shortId(id)}）。`
            + `${st.subject ? `课题「${st.subject}」，当前阶段「${PHASE_TEXT[phaseOf(st)] || phaseOf(st)}」` : '还没有课题：先问学生学什么课、用什么教材/素材'}。\n`
            + '请把这段原样转述给学生，不要自行加戏；没走到 teaching 阶段不许讲课、不许出题。';
        }
        touch(st);
        persist();
        return '✅ 教师模式已关闭（state: on=false）。可以正常回答，不再按教学规程走。';
      },
    }),
  ];
}



