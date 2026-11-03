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
import { CORE_RULES, IDLE_HINT, sessionHeader, composeRules, prepStateOf } from './rules.js';

export const name = 'dsh-teaching-mode';

/** 可选注入：systemPrompt 是宿主总是提供的；commands / tools 有就用。 */
export const inject = ['systemPrompt'];

const require = createRequire(import.meta.url);

/** 插件版本（诊断日志里带版本号，方便确认"重启后到底加载的是哪一版"） */
const VERSION = '0.9.3';

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
  // ── 出题门禁所需的本轮讲解记录（2026-10-23 v0.9.1）──
  // 规程只是文字，模型可以不听；这里记录本轮 assistant 已产出的正文，供 guard 判定「有没有讲」。
  const LESSON_MIN_CHARS = 150;
  const turnText = new Map();    // sessionId -> { turn, text } 本轮累积正文
  const attemptTurn = new Map(); // attemptId -> { sid, turn } 流式片段的归属
  const gatePassed = new Map();  // sessionId -> turn   本轮已放行过的出题
  const watchStream = (payload) => {
    try {
      const frame = payload?.frame;
      const sid = payload?.agent?.id;
      if (!frame || !sid) return;
      if (frame.type === 'start') {
        attemptTurn.set(frame.attemptId, { sid, turn: frame.turn });
        const cur = turnText.get(sid);
        if (!cur || cur.turn !== frame.turn) turnText.set(sid, { turn: frame.turn, text: '' });
        return;
      }
      if (frame.type === 'end') { attemptTurn.delete(frame.attemptId); return; }
      if (frame.type !== 'chunk') return;
      const chunk = frame.chunk;
      if (!chunk) return;
      const a = attemptTurn.get(frame.attemptId);
      if (!a) return;
      let cur = turnText.get(a.sid);
      if (!cur || cur.turn !== a.turn) { cur = { turn: a.turn, text: '' }; turnText.set(a.sid, cur); }
      // 正路：流式增量
      if (chunk.type === 'text-delta' && chunk.text) {
        if (cur.text.length < 40000) cur.text += chunk.text; // 防御：单轮正文不让内存无限涨
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
      if (!st.subject) return undefined;            // 连课题都还没有＝开课前问询，不拦
      if (!turnText.has(sid)) return undefined;      // 拿不到本轮文本（流监听不可用）→ 宁可放过，不许误杀
      if (gatePassed.get(sid) === turnText.get(sid).turn) return undefined; // 本轮已放行过，允许连出
      const text = String(turnText.get(sid).text || '').trim();
      if (text.length >= LESSON_MIN_CHARS) {
        gatePassed.set(sid, turnText.get(sid).turn);
        diag('gate-pass ' + shortId(sid) + ' chars=' + text.length);
        return undefined;
      }
      diag('gate-deny ' + shortId(sid) + ' chars=' + text.length);
      return '【教师模式门禁·出题被拒绝】本轮你只写了 ' + text.length + ' 字讲解，没有先讲就出题。'
        + '这不是提醒，是硬性拒绝：出题卡片必须是「同一条回复」里先有讲解、后有题目。\n'
        + '现在请在同一条回复里按顺序做完再重试出题：\n'
        + '1) 先讲清楚本次要考的那一个小知识点：是什么（定义/规则/公式，每个符号都说明白）；\n'
        + '2) 为什么成立（把推导或道理不跳步地说一遍）；\n'
        + '3) 一个具体例子（完整算/完整走一遍）。\n'
        + '题目必须只考刚讲的这个知识点，不许考下一个知识点。\n'
        + '如果这次调用不是出题而是课前问询（问课题、教材、考试范围、要不要继续），请先用一两句话说明你要问什么，再重试。';
    } catch { return undefined; }
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
                return composeRules(null, cfg) + courseHintText(store, id);
              }
              const cwd = st.cwd || context?.scope?.cwd || context?.cwd || '';
              if (ensureDataDir(st, cwd)) persist();
              const merged = healState(st) ? (persist(), st) : st;
              if (merged.on !== true) return composeRules(merged, cfg) + courseHintText(store, id);
              return composeRules(merged, cfg, peersOf(store, id || ''));
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
          if (OFF_RE.test(text)) { toggle(id, false); diag('auto-off ' + shortId(id)); }
          else if (ON_RE.test(text)) { toggle(id, true); diag('auto-on ' + shortId(id)); }
        } catch (e) {
          diag('auto-detect-failed ' + (e && e.message ? e.message : String(e)));
        }
      }, 'teaching-mode:auto-detect');
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
const ON_RE = /(开启|打开|进入|用)\s*教师模式|教师模式[，,]?\s*(开启|开一下)|上课|教我/;
const OFF_RE = /(关闭|退出|结束|关掉)\s*教师模式|下课/;

function messageText(msg) {
  const c = msg?.content;
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) {
    return c.filter((p) => p && p.type === 'text' && typeof p.text === 'string').map((p) => p.text).join('\n');
  }
  return '';
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
        touch(st);
        persist();
        const gate = st.prep === 'pending'
          ? '\n\n⛔ 备课闸门已关上：先问清四项再开讲——① 教材到手没有、目录页码齐不齐、缺哪些；② 有没有历年真题/试卷、几套、带不带答案；③ 这门课按什么路线走（章→节→知识点大纲，等学生确认）；④ 考试日期/题型分值/范围。落实后调用 teaching_prepare（confirmed: true）。'
          : '';
        return `已记录课题「${st.subject}」${st.material ? `｜教材「${st.material}」` : ''}\n资料落盘目录：${st.dataDir || '（未取到本对话工作目录，落盘目录待定）'}${reused}${gate}`;
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
          st.prep = 'confirmed';
          touch(st);
          persist();
          if (note && st.dataDir) {
            try { fs.writeFileSync(path.join(st.dataDir, '备课记录.md'), `# 备课记录\n\n更新时间：${new Date().toISOString()}\n\n${note}\n`, 'utf8'); } catch { /* 落盘失败不影响状态 */ }
          }
          return `✅ 备课已完成，闸门打开，可以开始讲解。${note ? `\n备课结论：${note}` : ''}\n下一步：按确认的路线讲第一个小知识点，讲完立刻出 1 道卡片选择题（先讲后考）。`;
        }
        st.prep = 'pending';
        touch(st);
        persist();
        return `⛔ 备课未完成，闸门关闭：这一轮不许讲知识点、不许出题。把四项问清——① 教材目录/页码/缺页；② 真题几套带不带答案；③ 章→节→知识点路线；④ 考试日期/题型分值/范围。`;
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
        return `已记错题（${layerText}）：${m.topic || m.question}${file ? `\n明细已追加：${file}` : '\n（还没有资料落盘目录，暂只记在状态里）'}`;
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
        return st.dataDir;
      },
    }),
  ];
}



