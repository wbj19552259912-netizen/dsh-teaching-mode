// 验证规程与状态头里的关键约束是否真的写进去了
// （注意：有些约束在 CORE_RULES 里，有些只在 sessionHeader 的输出里，所以要分别检查）
import { CORE_RULES, CORE_RULES_COMPACT, IDLE_HINT, sessionHeader } from '../lib/rules.js';

const coreChecks = [
  ['只生成第一章', '不写第二章'],
  ['不提前生成后面的内容', '不提前生成后面的内容'],
  ['问学生要不要开始下一章', '继续讲下一章'],
  ['标注生成内容', '不是原书原文'],
  ['禁止一口气写完整本', '永远不要一次把整本书写完'],
  ['落盘后必须记状态', '落盘后立刻记状态'],
  ['音标不得臆造冒充课本', '不要把臆造的音标混在里面冒充课本内容'],
  ['记状态用工具而非命令', '不要让用户敲命令'],
  ['题目选项不标推荐', '选项里一律不写“推荐”'],
  // 2026-10-21：学生投诉"很多时候还没给出教授内容就出题"，规程补硬性顺序约束
  ['先讲后考铁律', '先讲，再考'],
  ['禁止只发题目', '禁止只发题目'],
  ['禁止跳过讲解直接出题', '禁止跳过讲解直接出题'],
  ['讲授内容最低三项', '讲授内容的**最低要求**'],
  ['不许出题的场景', '一律不许出题，只能讲'],
  ['输出模板：讲解在前题目在后', '只有讲授内容与题目**同一条回复里都在**'],
  ['第四节自查出题前先看有无讲解', '题目**前面**是否已经有讲授内容'],
  // 2026-10-23：规程没写门禁时模型会发明"换个说法"绕过，改成硬门禁 + 只考刚讲的点
  ['硬门禁：本轮不足150字会被拒绝', '不足 150 字'],
  ['硬门禁：拒绝不是提醒', '不是提醒，是真的会被拒绝'],
  // 2026-11-03：只写批改就出下一题的事故 → 门禁同时看"有没有讲授段"
  ['硬门禁：只写批改不算讲解', '批改不算讲授'],
  ['规程：每个知识点要报编号', '每个知识点都要报编号'],
  ['题目只考刚讲的点', '讲的是 A，就只能考 A'],
  ['第四节自查题目是否只考刚讲的点', '刚讲的那个**知识点'],
];

// 精简版（讲过 5 节以上才启用，最容易踩坑的是英语/Python 这类长课）
const compactChecks = [
  ['精简版：先讲再考', '先讲再考'],
  ['精简版：禁止只发题目', '绝不能只发题目'],
  ['精简版：硬门禁', '不足 150 字'],
  ['精简版：只写批改不算讲解', '批改不算讲授'],
  ['精简版：只考刚讲的点', '讲 A 就只能考 A'],
];

let pass = 0, total = 0;
console.log('=== CORE_RULES（教学档正文）===');
for (const [name, needle] of coreChecks) {
  total++;
  const ok = CORE_RULES.includes(needle);
  if (ok) pass++;
  console.log(`${ok ? '✅' : '❌'} ${name}（找 "${needle}"）`);
}

// 状态头：只在"已有小节进度"时才会输出这些行，所以造一个有进度的状态
const header = sessionHeader({
  on: true,
  subject: '测试课题',
  chapter: '第1章',
  currentSection: '1.2 介绍自己',
  learnedSections: ['1.1 见面打招呼'],
  nextSection: '1.3 性格与爱好',
  debts: [],
  finished: [],
  dataDir: 'D:/x/projects/测试课题/03-产出',
});

console.log('\n=== sessionHeader（随状态变化的部分）===');
const headerChecks = [
  ['状态头显示当前小节', '当前小节：1.2 介绍自己'],
  ['状态头显示已讲完的小节', '已讲完的小节：1.1 见面打招呼'],
  ['状态头显示下一小节', '下一小节：1.3 性格与爱好'],
  ['小节边界约束', '不要跳到更后面'],
  ['落盘位置提示', '资料落盘位置：D:/x/projects/测试课题/03-产出'],
];
for (const [name, needle] of headerChecks) {
  total++;
  const ok = header.includes(needle);
  if (ok) pass++;
  console.log(`${ok ? '✅' : '❌'} ${name}（找 "${needle}"）`);
}

console.log('\n=== CORE_RULES_COMPACT（长课精简档）===');
for (const [name, needle] of compactChecks) {
  total++;
  const ok = CORE_RULES_COMPACT.includes(needle);
  if (ok) pass++;
  console.log(`${ok ? '✅' : '❌'} ${name}（找 "${needle}"）`);
}

console.log(`\n规程长度: ${CORE_RULES.length} 字符（精简档 ${CORE_RULES_COMPACT.length} 字符） | 识别提示: ${IDLE_HINT.length} 字符 | 状态头: ${header.length} 字符`);
console.log(`结果: ${pass}/${total}`);
process.exit(pass === total ? 0 : 1);
