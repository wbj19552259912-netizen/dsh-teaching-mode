/**
 * dsh-teaching-mode 测试（本地 mock Host，不启动 DSH、不调模型、零费用）
 *
 * 覆盖：命令注册与全部子命令、开关注入行为、状态持久化、多会话隔离、规程文本关键约定。
 * 用法：node tests/test.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ENTRY = path.join(HERE, '..', 'lib', 'index.js');
const TMP_STATE = path.join(os.tmpdir(), `teaching-mode-test-${process.pid}.json`);

let pass = 0, fail = 0;
const results = [];
function check(name, cond, detail = '') {
  if (cond) { pass++; results.push({ name, ok: true, detail }); console.log(`✅ ${name}${detail ? ' — ' + detail : ''}`); }
  else { fail++; results.push({ name, ok: false, detail }); console.log(`❌ ${name}${detail ? ' — ' + detail : ''}`); }
}

// ── mock Host ──
const calls = { sections: [], commands: [], effects: [], logs: [], injects: [], tools: [] };
const listeners = new Map();
/** 触发某事件的所有监听器（模拟 Host 派发） */
const emit = (evt, ...args) => {
  for (const { fn } of listeners.get(evt) ?? []) {
    try { fn(...args); } catch { /* 忽略：与宿主行为一致，监听器抛错不影响派发 */ }
  }
};
const services = {
  commands: { register: (def) => { calls.commands.push(def); return () => {}; } },
  tools: { register: (def) => { calls.tools.push(def); return () => {}; } },
};
/** 与真实 Host 一致：section 的 order 必须是有限数字，否则注册直接抛错 */
const sectionRegistrar = (sink) => (def) => {
  if (!Number.isFinite(def.order)) throw new TypeError(`prompt section "${def.name}" order must be a finite number`);
  sink.push(def);
  return () => {};
};
const mockCtx = {
  logger: { info: (m) => calls.logs.push(String(m)), warn: () => {}, error: () => {} },
  effect: (fn, label) => { calls.effects.push(label); try { fn(); } catch (e) { calls.logs.push('effect error: ' + e.message); } return () => {}; },
  systemPrompt: { section: sectionRegistrar(calls.sections) },
  // Cordis 的可选依赖写法：服务名 → 只在服务存在时才执行回调
  inject: (names, cb) => {
    calls.injects.push(names.join(','));
    const injected = {};
    let allPresent = true;
    for (const n of names) {
      if (services[n] === undefined) { allPresent = false; break; }
      injected[n] = services[n];
    }
    if (allPresent) cb(injected);
  },
  // 事件监听：记录下来，测试里可以手动触发
  on: (evt, fn, label) => {
    const arr = listeners.get(evt) ?? [];
    arr.push({ fn, label });
    listeners.set(evt, arr);
    return () => {};
  },
  set: () => {},
};

const mod = await import(pathToFileURL(ENTRY).href);
mod.apply(mockCtx, { statePath: TMP_STATE });

// ── 1. 插件契约 ──
check('导出 name / inject / apply', mod.name === 'dsh-teaching-mode' && Array.isArray(mod.inject) && typeof mod.apply === 'function', `inject=${JSON.stringify(mod.inject)}`);
check('inject 含 systemPrompt', mod.inject.includes('systemPrompt'));
check('注册了 systemPrompt.section', calls.sections.length === 1, calls.sections[0]?.name);
check('section 文本是函数（可动态）', typeof calls.sections[0]?.text === 'function');
check('section 带有限 order（Host 会校验，缺了整段注入会失败）', Number.isFinite(calls.sections[0]?.order), String(calls.sections[0]?.order));
check('注册了 /teaching 命令', calls.commands.length === 1 && calls.commands[0].name === 'teaching');
check('注入经 ctx.effect 包裹', calls.effects.length >= 1, calls.effects.join(','));

const cmd = calls.commands[0];
const run = (rawInput, sid = 's1') => cmd.handler({ rawInput, agent: { id: sid } });

// ── 参数解析：真机曾出现 args 为空、rawInput 里带参数的情况 ──
const rArgsOnly = await cmd.handler({ rawInput: '/teaching', args: 'on', agent: { id: 'argsTest' } });
check('参数在 invocation.args 里也能识别（on）', rArgsOnly.kind === 'success' && rArgsOnly.text.includes('已开启'), rArgsOnly.text.split('\n')[0]);
const rArgsSetup = await cmd.handler({ rawInput: '/teaching', args: 'setup 数学 | 高数上册', agent: { id: 'argsTest' } });
check('参数在 args 里也能识别（setup）', rArgsSetup.kind === 'success' && rArgsSetup.text.includes('数学'), rArgsSetup.text.split('\n')[0]);
const rRawOnly = await cmd.handler({ rawInput: '/teaching off', agent: { id: 'argsTest' } });
check('参数在 rawInput 里仍能识别（off）', rRawOnly.kind === 'success' && rRawOnly.text.includes('已关闭'), rRawOnly.text.split('\n')[0]);
const rPlain = await cmd.handler({ rawInput: '/teaching', agent: { id: 'argsTest' } });
check('无参数时回落到查状态', rPlain.kind === 'success' && rPlain.text.includes('教师模式：'), rPlain.text.split('\n')[0]);

// ── 2. 未开启时：只注入极轻的"识别提示"，不注入完整规程 ──
// 注入文本现在必须带会话身份（context.scope.id）——这正是修复串台后的语义
const injectFor = (sessionId) => {
  // 所有已注册的 section 都按 context.scope.id 取状态；取第一个有内容的即可
  for (const sec of calls.sections) {
    const t = sec.text({ scope: { id: sessionId } });
    if (t && t.trim()) return t;
  }
  return '';
};
const idle = injectFor('s1');
check('未开启时注入识别提示（非空）', typeof idle === 'string' && idle.length > 0, `${idle.length} 字符`);
check('识别提示含"开启教师模式"触发条件', idle.includes('开启教师模式'));
check('识别提示要求先备课', idle.includes('备课'));
check('识别提示不含三级粒度规程（说明是轻量档）', !idle.includes('三级粒度'));
check('识别提示显著短于完整规程', idle.length < 900, `${idle.length} 字符`);

// ── 3. /teaching on 行为 ──
const rOn = await run('/teaching on');
check('on 返回 success', rOn.kind === 'success', rOn.text.split('\n')[0]);
const injected = injectFor('s1');
check('开启后注入非空', typeof injected === 'string' && injected.length > 500, `${injected.length} 字符`);
check('注入含微点模板约定', injected.includes('微点') && injected.includes('标准回答'));
check('注入含小节复习资料要求', injected.includes('复习资料'));
check('注入含"先问，不猜"备课要求', injected.includes('先问，不猜'));
check('注入含作业题不配检验题', injected.includes('不配检验题'));

// ── 4. 子命令 ──
const rSetup = await run('/teaching setup 汇编语言 | 王爽《汇编语言》第四版');
check('setup 记录课题与教材', rSetup.kind === 'success' && rSetup.text.includes('汇编语言'), rSetup.text);
const rProg = await run('/teaching progress 第8章 8.5 数据有多长');
check('progress 记录进度', rProg.kind === 'success' && rProg.text.includes('8.5'));
const rDebt = await run('/teaching debt 第3章源程序结构');
check('debt 记录欠账', rDebt.kind === 'success' && rDebt.text.includes('第3章'));
const rDone = await run('/teaching done 8.4 寻址方式总表');
check('done 记录已完成', rDone.kind === 'success' && rDone.text.includes('8.4'));

// ── 逐章生成相关命令（学生要求：一次只生成一章）──
const rGen = await run('/teaching gen 第1章');
check('gen 记录已生成教材的章', rGen.kind === 'success' && rGen.text.includes('第1章'), rGen.text.split('\n')[0]);
const rGen2 = await run('/teaching gen 第1章');
check('gen 重复记录不重复加入', rGen2.kind === 'success' && rGen2.text.includes('共 1 章'), rGen2.text.split('\n')[1] || rGen2.text);
const rNext = await run('/teaching next 第2章');
check('next 设置下一章', rNext.kind === 'success' && rNext.text.includes('第2章'), rNext.text.split('\n')[0]);
const rLearn = await run('/teaching learn 第1章');
check('learn 标记学完并提示继续', rLearn.kind === 'success' && rLearn.text.includes('已标记学完') && rLearn.text.includes('继续'), rLearn.text.split('\n')[0]);
const rLearnNoArg = await run('/teaching learn');
check('learn 缺参数报错', rLearnNoArg.kind === 'error', rLearnNoArg.text.split('\n')[0]);
const rStatusCh = await run('/teaching status');
check('status 显示逐章进度', rStatusCh.text.includes('已生成教材') && rStatusCh.text.includes('下一章'), rStatusCh.text.split('\n')[0]);

const injected2 = injectFor('s1');
check('状态变化反映到注入文本', injected2.includes('汇编语言') && injected2.includes('8.5') && injected2.includes('第3章源文件') === false ? true : injected2.includes('汇编语言'));

const rStatus = await run('/teaching status');
check('status 汇总显示', rStatus.kind === 'success' && rStatus.text.includes('已开启') && rStatus.text.includes('8.5'), rStatus.text.split('\n')[0]);

// ── 5. 参数缺失要报错 ──
for (const [v, label] of [['setup', 'setup'], ['progress', 'progress'], ['debt', 'debt'], ['done', 'done']]) {
  const r = await run(`/teaching ${v}`);
  check(`${label} 缺参数返回 error`, r.kind === 'error', r.text.split('\n')[0]);
}

// ── 6. 多会话隔离 ──
await run('/teaching setup 数学 | 高等数学上册', 's2');
// ── 6b. 考试信息字段（用户定位：帮大学生过期末）──
const rExam = await run('/teaching exam 2026-12-31 | 选择20+简答30+计算50 | 第1-5章，第3章最重 | 历年5套，2套带答案', 'examS');
check('exam 记录四类考试信息', rExam.kind === 'success' && rExam.text.includes('2026-12-31') && rExam.text.includes('简答'),
  rExam.text.split('\n')[0]);
const rExamStatus = await run('/teaching exam', 'examS');
check('exam 无参数时回显已存信息', rExamStatus.kind === 'success' && rExamStatus.text.includes('第1-5章'), rExamStatus.text.split('\n')[2]);
await run('/teaching on', 'examS');
const examInjected = injectFor('examS');
check('考试信息进入教学模式注入', examInjected.includes('考试：') && examInjected.includes('第1-5章'), examInjected.match(/- 考试：.*/)?.[0]?.slice(0, 70) || '');
check('注入含倒计时', /还有 \d+ 天/.test(examInjected), examInjected.match(/还有 \d+ 天/)?.[0] || '未找到倒计时');

// ── 会话隔离 ──
await run('/teaching on', 's2');
await run('/teaching off', 's1');
const s1 = await run('/teaching status', 's1');
const s2 = await run('/teaching status', 's2');
check('会话隔离：s1 已关闭', s1.text.includes('已关闭'), s1.text.split('\n')[0]);
check('会话隔离：s2 仍开启', s2.text.includes('已开启'), s2.text.split('\n')[0]);
check('会话隔离：s2 有自己的课题', s2.text.includes('数学'));

// ── 7. 状态持久化 ──
check('状态文件已写入', fs.existsSync(TMP_STATE));
const store = JSON.parse(fs.readFileSync(TMP_STATE, 'utf8'));
check('状态文件结构正确', store.version === 1 && !!store.sessions.s1 && !!store.sessions.s2);
check('状态文件含欠账记录', Array.isArray(store.sessions.s1.debts) && store.sessions.s1.debts.length === 1, JSON.stringify(store.sessions.s1.debts));

// ── 8. reset ──
const rReset = await run('/teaching reset', 's1');
check('reset 返回 success', rReset.kind === 'success');
const afterReset = await run('/teaching status', 's1');
check('reset 后状态清空', afterReset.text.includes('未设置') && afterReset.text.includes('已关闭'));

// ── 9. 未知子命令回落到 status ──
const rUnknown = await run('/teaching 随便什么');
check('未知子命令回落到 status', rUnknown.kind === 'success' && rUnknown.text.includes('教师模式：'));

// ── 10. 规程文本不含模板占位符残留 ──
check('注入文本无占位符残留', !injected.includes('${') && !injected.includes('undefined'));

// ── 11. 自动识别：插件监听用户消息，命中触发词就自动开关 ──
// 用"按会话断言"而不是全局注入文本：其他用例可能留下仍在开启的会话，
// 注入文本会取最新那个，容易误判。
const stateOfStore = () => {
  try { return JSON.parse(fs.readFileSync(TMP_STATE, 'utf8')).sessions || {}; } catch { return {}; }
};

const AUTO_ID = 'auto1';
emit('agent/inbox/claimed', { agent: { id: AUTO_ID }, message: { role: 'user', content: [{ type: 'text', text: '开启教师模式' }] } });
check('识别"开启教师模式"→ 该会话自动开启', stateOfStore()[AUTO_ID]?.on === true, JSON.stringify(stateOfStore()[AUTO_ID] || null).slice(0, 60));

emit('agent/inbox/claimed', { agent: { id: AUTO_ID }, message: { role: 'user', content: [{ type: 'text', text: '下课' }] } });
check('识别"下课"→ 该会话自动关闭', stateOfStore()[AUTO_ID]?.on === false, JSON.stringify(stateOfStore()[AUTO_ID] || null).slice(0, 60));

// 日常语句不得误触发
emit('agent/inbox/claimed', { agent: { id: 'auto2' }, message: { role: 'user', content: [{ type: 'text', text: '帮我看看这段代码有什么问题' }] } });
check('日常提问不误触发', stateOfStore()['auto2'] === undefined, JSON.stringify(stateOfStore()['auto2'] || null));

// 变体说法也要认
emit('agent/inbox/claimed', { agent: { id: 'auto3' }, message: { role: 'user', content: [{ type: 'text', text: '用教师模式教我汇编' }] } });
check('识别"用教师模式"变体', stateOfStore()['auto3']?.on === true, JSON.stringify(stateOfStore()['auto3'] || null).slice(0, 60));

// ── 12. 模型工具：让 AI 自己录状态，学生不用敲命令（用户反馈的根因修复）──
// v0.9.0：新增 teaching_prepare（备课闸门），工具数 5 → 6
check('注册了 9 个模型工具', calls.tools.length === 9, calls.tools.map((t) => t.name).join(', '));

const tool = (n) => calls.tools.find((t) => t.name === n);
check('工具名齐全', !!tool('teaching_setup') && !!tool('teaching_prepare') && !!tool('teaching_update') && !!tool('teaching_exam') && !!tool('teaching_mistake') && !!tool('teaching_note_path'));

const setupTool = tool('teaching_setup');
check('工具 schema 是 JSON Schema（含 properties/required）',
  setupTool.parameters?.type === 'object' && !!setupTool.parameters.properties?.subject
  && Array.isArray(setupTool.parameters.required) && setupTool.parameters.required.includes('subject'),
  JSON.stringify(setupTool.parameters).slice(0, 120));
check('工具带 output.render（DSH 要求）', typeof setupTool.output?.render === 'function');
check('工具未声明并发安全（保守）', setupTool.isConcurrencySafe() === false);

const sess = 'tool-sess';
const rSetupTool = await setupTool.execute({ subject: '模式识别', material: '吴保俊 9章PPT' }, { agent: { id: sess } });
check('teaching_setup 写入课题', typeof rSetupTool === 'string' && rSetupTool.includes('模式识别'), String(rSetupTool).slice(0, 60));

const rUpdateTool = await tool('teaching_update').execute(
  { progress: '第1章 1.1', next_chapter: '第2章', debt: '第三章2.jpg 读图失败' },
  { agent: { id: sess } },
);
check('teaching_update 三项都写入',
  rUpdateTool.includes('第1章 1.1') && rUpdateTool.includes('第2章') && rUpdateTool.includes('读图失败'),
  String(rUpdateTool).replace(/\n/g, ' ').slice(0, 100));

const rExamTool = await tool('teaching_exam').execute({ date: '2026-12-31', types: '选择20+简答30' }, { agent: { id: sess } });
check('teaching_exam 写入并算倒计时', rExamTool.includes('2026-12-31') && /还有 \d+ 天/.test(rExamTool), String(rExamTool).slice(0, 80));

const stSessions = JSON.parse(fs.readFileSync(TMP_STATE, 'utf8')).sessions || {};
check('工具写入的状态已持久化', !!stSessions[sess] && stSessions[sess].subject === '模式识别', JSON.stringify(stSessions[sess] || null).slice(0, 70));

const rEmpty = await tool('teaching_update').execute({}, { agent: { id: sess } });
check('空参数不修改状态', rEmpty.includes('没有需要更新'), String(rEmpty).slice(0, 40));

// ── 13. 小节级进度：从 chapter 里拆出来的结构字段（2026-10-16 修）──
const tool2 = (n) => calls.tools.find((t) => t.name === n);
const secSess = 'section-sess';
// 先把"当前小节"设上，再做三字段更新（否则 learn-section 会把它清空）
await run('/teaching section 1.2 介绍自己', secSess);

const rSec = await tool2('teaching_update').execute(
  { current_section: '1.2 介绍自己', learned_section: '1.1 见面打招呼', next_section: '1.3 性格与爱好' },
  { agent: { id: secSess } },
);
check('teaching_update 支持小节三字段',
  rSec.includes('1.2 介绍自己') && rSec.includes('1.1 见面打招呼') && rSec.includes('1.3 性格与爱好'),
  String(rSec).replace(/\n/g, ' ').slice(0, 90));

const secStore = JSON.parse(fs.readFileSync(TMP_STATE, 'utf8')).sessions[secSess] || {};
check('小节字段已落盘',
  secStore.currentSection === '1.2 介绍自己' && secStore.nextSection === '1.3 性格与爱好',
  JSON.stringify({ cur: secStore.currentSection, next: secStore.nextSection }));
check('已讲完小节进入数组',
  Array.isArray(secStore.learnedSections) && secStore.learnedSections.includes('1.1 见面打招呼'),
  JSON.stringify(secStore.learnedSections || []));

await run('/teaching section 1.3 性格与爱好', secSess);
await run('/teaching learn-section 1.3 性格与爱好', secSess);
const afterSec = JSON.parse(fs.readFileSync(TMP_STATE, 'utf8')).sessions[secSess] || {};
check('讲完的小节不再算"当前小节"', afterSec.currentSection === '', `currentSection="${afterSec.currentSection}"`);
check('累计小节数正确',
  Array.isArray(afterSec.learnedSections) && afterSec.learnedSections.length === 2,
  JSON.stringify(afterSec.learnedSections || []));

// 状态头断言：需要"当前小节"有值（上一步的 learn-section 已按正确逻辑把它清空）
// 2026-10-18：讲完 1.3 之后不能再把 1.3 写成"下一小节"（会被陈旧自愈清掉），所以这里换 1.4
await run('/teaching next-section 1.4 爱好与习惯', secSess);
await run('/teaching section 1.2 介绍自己', secSess);
await run('/teaching on', secSess);
const secInjected = injectFor(secSess);
check('状态头显示小节级进度',
  secInjected.includes('当前小节：') && secInjected.includes('下一小节：') && secInjected.includes('已讲完的小节：'),
  (secInjected.match(/- (当前小节|下一小节|已讲完的小节)：.*/g) || []).join(' | ').slice(0, 130));

// ── 14. 不串台（2026-10-16 修的真实 bug）──
// 曾经：全局扫描所有会话、挑一个"开着的"注入 → 任一会话开课会让所有对话都被注入它的规程。
// 现在：注入文本按 context.scope.id 取本会话状态，取不到就给识别提示。
const crossIdle = injectFor('never-opened-session-xyz');
check('未开课的会话只得到识别提示（不串台）',
  crossIdle.includes('当前未开启') && !crossIdle.includes('三级粒度'),
  crossIdle.slice(0, 40));
await run('/teaching on', 'cross-owner');
const crossOther = injectFor('cross-bystander');
check('别的会话开课不影响本会话注入',
  crossOther.includes('当前未开启') && !crossOther.includes('标准回答'),
  crossOther.slice(0, 40));
const crossOwner = injectFor('cross-owner');
check('开课会话自己仍能拿到完整规程',
  crossOwner.includes('微点') && crossOwner.length > 1500,
  `${crossOwner.length} 字符`);

// ── 15. 状态机改造（2026-10-18 v0.7.3）──
// 15.1 讲完一节自动推进：一次传"讲完 + 下一节"，当前小节自己往前走
const adv = 'adv-sess';
await run('/teaching on', adv);
await run('/teaching section 2.1 话题与词汇', adv);
const rFinish = await run('/teaching finish-section 2.1 话题与词汇 | 2.2 一般现在时', adv);
const advState = stateOfStore()[adv] || {};
check('finish-section 返回自动推进提示', rFinish.kind === 'success' && rFinish.text.includes('自动切到'), rFinish.text.split('\n')[1] || '');
check('讲完一节后当前小节切到下一节', advState.currentSection === '2.2 一般现在时', `currentSection="${advState.currentSection}"`);
check('讲完一节后下一小节清空（已升为当前）', advState.nextSection === '', `nextSection="${advState.nextSection}"`);
check('讲完一节后进入已学清单', (advState.learnedSections || []).includes('2.1 话题与词汇'), JSON.stringify(advState.learnedSections || []));

// 15.2 工具层一次调用完成推进（模型不用再记得调三次）
await tool('teaching_update').execute({ finished_section: '2.2 一般现在时', next_section: '2.3 助动词' }, { agent: { id: adv } });
const advState2 = stateOfStore()[adv] || {};
check('工具层一次调用完成小节推进',
  advState2.currentSection === '2.3 助动词' && (advState2.learnedSections || []).includes('2.2 一般现在时'),
  `current="${advState2.currentSection}" learned=${(advState2.learnedSections || []).length}`);

// 15.3 整章学完：写章节清单、清空小节、记下一章
const rFinishCh = await run('/teaching finish-chapter 第2章 | 第3章', adv);
const chState = stateOfStore()[adv] || {};
check('整章学完写入已学完清单', (chState.learnedChapters || []).includes('第2章'), JSON.stringify(chState.learnedChapters || []));
check('整章学完清空小节进度', chState.currentSection === '' && chState.nextSection === '', `cur="${chState.currentSection}" next="${chState.nextSection}"`);
check('整章学完记录下一章', chState.nextChapter === '第3章', `nextChapter="${chState.nextChapter}"`);
check('整章学完提示按规矩只生成一章', rFinishCh.text.includes('只生成这一章'), rFinishCh.text.split('\n').pop());

// 15.4 字段长度上限：超长直接拒绝，不静默截断
const rLong = await run('/teaching progress ' + '很长的进度'.repeat(20), 'limit-sess');
check('超长章名被拒绝', rLong.kind === 'error' && rLong.text.includes('太长'), rLong.text.slice(0, 50));
const rLongTool = await tool('teaching_setup').execute({ subject: 'x'.repeat(60) }, { agent: { id: 'limit-sess' } });
check('工具传超长字段也被拒绝', String(rLongTool).includes('太长'), String(rLongTool).slice(0, 40));
const afterLong = stateOfStore()['limit-sess'] || {};
check('超长被拒后状态没被改动', !afterLong.subject && !afterLong.chapter, JSON.stringify({ s: afterLong.subject, c: afterLong.chapter }));

// 15.5 欠账上限（50 条）
const debtSess = 'debt-limit-sess';
for (let i = 0; i < 50; i++) await run(`/teaching debt 欠账第${i}条`, debtSess);
const rDebtFull = await run('/teaching debt 第51条', debtSess);
check('欠账达到上限后拒绝新增', rDebtFull.kind === 'error' && rDebtFull.text.includes('已满'), rDebtFull.text.split('\n')[0]);

// 15.6 陈旧自愈 + /teaching repair：用独立状态文件的实例，造一份和真机一样的脏数据
// （不能直接改主 TMP_STATE：插件的状态是 apply 时读进内存的，改文件不会回灌）
const dirtyFile = path.join(os.tmpdir(), `teaching-mode-dirty-${process.pid}.json`);
fs.writeFileSync(dirtyFile, JSON.stringify({
  version: 1,
  sessions: {
    'dirty-1': {
      on: true, subject: '测试课题', material: '',
      chapter: '第2章 Unit 2 Hobbies 开讲（全面学习模式：词汇+语法+语音+阅读+写作+单元卷）；当前进入小节 2.1 话题与词汇 · 知识点 A · 小知识点 A1（play + 球类运动）',
      currentSection: '1.2 介绍自己',
      learnedSections: ['1.2 介绍自己'],
      nextSection: '1.2 介绍自己',
      finished: [], debts: [], generatedChapters: [], learnedChapters: [], nextChapter: '', dataDir: '',
    },
    'dirty-2': {
      on: true, subject: 'Python', material: '',
      chapter: '第5章 分支结构（九节全部讲完）',
      currentSection: '第一节 if 语句：程序的第一个岔路口（A.05.01）',
      learnedSections: ['第一节 if 语句与代码块（A.05.01，微点 1.1~1.4）', '第二节 if-else（A.05.02）'],
      nextSection: '第九节 常见错误（A.05.09）',
      finished: [], debts: [], generatedChapters: [], learnedChapters: [], nextChapter: '第6章', dataDir: '',
    },
  },
}, null, 2));
const dirtyCalls = { sections: [], commands: [] };
const dirtyCtx = {
  logger: { info: () => {}, warn: () => {}, error: () => {} },
  effect: (fn) => { try { fn(); } catch { /* 忽略 */ } return () => {}; },
  systemPrompt: { section: sectionRegistrar(dirtyCalls.sections) },
  inject: (names, cb) => {
    if (names.includes('commands')) cb({ commands: { register: (d) => { dirtyCalls.commands.push(d); return () => {}; } } });
    if (names.includes('tools')) cb({ tools: { register: () => () => {} } });
  },
  on: () => () => {},
  set: () => {},
};
const dirtyMod = await import(pathToFileURL(ENTRY).href + '?dirty=' + Date.now());
dirtyMod.apply(dirtyCtx, { statePath: dirtyFile });
// apply 里的启动自愈已经把这份脏数据修好了（幂等，load 即修），随后再敲 repair 应当是"无事可做"
const repaired = JSON.parse(fs.readFileSync(dirtyFile, 'utf8')).sessions['dirty-1'] || {};
const rRepair = await dirtyCalls.commands[0].handler({ rawInput: '/teaching repair', agent: { id: 'dirty-1' } });
check('启动自愈：清掉"已讲完却还挂着"的当前小节', repaired.currentSection === '', `currentSection="${repaired.currentSection}"`);
check('启动自愈：清掉"已讲完却还挂着"的下一小节', repaired.nextSection === '', `nextSection="${repaired.nextSection}"`);
check('启动自愈：把超长章名拆成短名+备注',
  repaired.chapter.length <= 60 && (repaired.chapterNote || '').length > 0,
  `chapter(${repaired.chapter.length})="${repaired.chapter}" note=${(repaired.chapterNote || '').length}字`);
check('拆出的备注括号配对', ((repaired.chapterNote || '').match(/[（(]/g) || []).length === ((repaired.chapterNote || '').match(/[）)]/g) || []).length,
  `note 末尾="${(repaired.chapterNote || '').slice(-16)}"`);
check('已修干净后 repair 报"没有需要修复"', rRepair.kind === 'success' && rRepair.text.includes('没有需要修复'), rRepair.text.split('\n')[0]);
const dirtyInjected = dirtyCalls.sections[0].text({ scope: { id: 'dirty-1' } });
check('状态头把章节备注单独一行注入', dirtyInjected.includes('章节备注：'), (dirtyInjected.match(/- 章节备注：.*/) || [''])[0].slice(0, 50));
// 同一节换个详略写法，也要认得出来（Python 真机数据：当前"第一节 if 语句：…（A.05.01）"、已学"第一节 if 语句与代码块（A.05.01，微点 1.1~1.4）"）
const dirty2 = JSON.parse(fs.readFileSync(dirtyFile, 'utf8')).sessions['dirty-2'] || {};
check('详略不同但同一节，也算陈旧并清掉', dirty2.currentSection === '', `currentSection="${dirty2.currentSection}"`);
try { fs.unlinkSync(dirtyFile); } catch { /* 忽略 */ }

// 15.7 工具 schema 暴露新参数
const updParams = tool('teaching_update').parameters.properties;
check('teaching_update 暴露 finished_section / finished_chapter / generated_chapter',
  !!updParams.finished_section && !!updParams.finished_chapter && !!updParams.generated_chapter,
  Object.keys(updParams).join(','));
check('teaching_update 暴露 debt_resolved / debt_dropped',
  !!updParams.debt_resolved && !!updParams.debt_dropped, Object.keys(updParams).join(','));

// ── 16. v0.8.0 复习闭环：欠账可销账 / 错题结构化 / 注入与复习 ──
const rev = 'review-sess';
await run('/teaching on', rev);
await run('/teaching debt 第三人称单数漏加 s', rev);
const stRev = JSON.parse(fs.readFileSync(TMP_STATE, 'utf8')).sessions[rev];
check('欠账升级为可销账条目', Array.isArray(stRev.debts) && stRev.debts.length === 1 && stRev.debts[0].status === 'open' && !!stRev.debts[0].id, JSON.stringify(stRev.debts[0]));
const rDebts1 = await run('/teaching debts', rev);
check('debts 列出未销欠账', rDebts1.kind === 'success' && rDebts1.text.includes('未销 1 条') && rDebts1.text.includes('第三人称'), rDebts1.text.split('\n')[0]);
const rRes1 = await run('/teaching resolve 1', rev);
check('按编号销账', rRes1.kind === 'success' && rRes1.text.includes('已销账'), rRes1.text.split('\n')[0]);
const rResAgain = await run('/teaching resolve 1', rev);
check('已销的欠账不能再销', rResAgain.kind === 'error' && rResAgain.text.includes('不用再销'), rResAgain.text);
await run('/teaching debt hair 不可数', rev);
const rDrop = await run('/teaching drop hair', rev);
check('按关键词作废', rDrop.kind === 'success' && rDrop.text.includes('已作废'), rDrop.text.split('\n')[0]);
const stRev2 = JSON.parse(fs.readFileSync(TMP_STATE, 'utf8')).sessions[rev];
check('作废后没有未销欠账', stRev2.debts.filter((d) => d.status === 'open').length === 0, JSON.stringify(stRev2.debts.map((d) => d.status)));
const rStatusRev = await run('/teaching status', rev);
check('status 显示未销/已销条数', rStatusRev.text.includes('条未销'), (rStatusRev.text.match(/- 欠账：.*/) || [''])[0]);

// 销账只保留最近 50 条
const cap = 'cap-sess';
for (let i = 0; i < 60; i++) {
  await run(`/teaching debt 批量欠账${i}`, cap);
  await run(`/teaching resolve 批量欠账${i}`, cap);
}
const stCap = JSON.parse(fs.readFileSync(TMP_STATE, 'utf8')).sessions[cap];
check('已销欠账只保留最近 50 条', stCap.debts.length === 50, `debts=${stCap.debts.length}`);

// 旧字符串状态自动迁移（幂等）
const legacyFile = path.join(os.tmpdir(), `teaching-legacy-${process.pid}.json`);
fs.writeFileSync(legacyFile, JSON.stringify({ version: 1, sessions: { legacy: { on: true, subject: '旧课', debts: ['旧账A', '旧账B'], updatedAt: '2026-10-01T00:00:00Z' } } }), 'utf8');
const legacyCalls = { sections: [], commands: [], tools: [] };
const legacyCtx = {
  logger: { info: () => {}, warn: () => {}, error: () => {} },
  effect: (fn) => { try { fn(); } catch { /* 忽略 */ } return () => {}; },
  systemPrompt: { section: sectionRegistrar(legacyCalls.sections) },
  inject: (names, cb) => {
    if (names.includes('commands')) cb({ commands: { register: (d) => { legacyCalls.commands.push(d); return () => {}; } } });
    if (names.includes('tools')) cb({ tools: { register: (t) => { legacyCalls.tools.push(t); return () => {}; } } });
  },
  on: () => () => {},
  set: () => {},
};
const legacyMod = await import(pathToFileURL(ENTRY).href + '?legacy=' + Date.now());
legacyMod.apply(legacyCtx, { statePath: legacyFile });
const legacyState = JSON.parse(fs.readFileSync(legacyFile, 'utf8')).sessions.legacy;
check('旧字符串欠账自动迁移为带编号条目',
  Array.isArray(legacyState.debts) && legacyState.debts.length === 2 && legacyState.debts[0].text === '旧账A' && legacyState.debts[0].id === '1' && legacyState.debts[0].status === 'open',
  JSON.stringify(legacyState.debts));
const legacyHeader = legacyCalls.sections[0].text({ scope: { id: 'legacy' } });
check('注入头显示待销欠账与编号', legacyHeader.includes('- 待销欠账（2 条') && legacyHeader.includes('[1] 旧账A'), (legacyHeader.match(/- 待销欠账.*/) || [''])[0].slice(0, 60));

// 错题结构化：计数进状态、明细进 错题本.md
const errDir = path.join(os.tmpdir(), `teaching-err-${process.pid}`);
fs.mkdirSync(errDir, { recursive: true });
const errFile = path.join(os.tmpdir(), `teaching-errstate-${process.pid}.json`);
fs.writeFileSync(errFile, JSON.stringify({ version: 1, sessions: { err: { on: true, subject: '错题课', dataDir: errDir } } }), 'utf8');
const errCalls = { sections: [], commands: [], tools: [] };
const errCtx = { ...legacyCtx, systemPrompt: { section: sectionRegistrar(errCalls.sections) }, inject: (names, cb) => {
  if (names.includes('commands')) cb({ commands: { register: (d) => { errCalls.commands.push(d); return () => {}; } } });
  if (names.includes('tools')) cb({ tools: { register: (t) => { errCalls.tools.push(t); return () => {}; } } });
} };
const errMod = await import(pathToFileURL(ENTRY).href + '?err=' + Date.now());
errMod.apply(errCtx, { statePath: errFile });
const errTool = errCalls.tools.find((t) => t.name === 'teaching_mistake');
const rMistake = await errTool.execute({ topic: '第三人称单数', question: 'She ___ (go) to school.', my_answer: 'go', correct: 'goes', cause: '漏了 -es，只改了一个动词', layer: '记法' }, { agent: { id: 'err' } });
check('teaching_mistake 记录错题', typeof rMistake === 'string' && rMistake.includes('已记错题（记法）'), rMistake.split('\n')[0]);
const errState = JSON.parse(fs.readFileSync(errFile, 'utf8')).sessions.err;
check('错题计数与分层落地', errState.mistakeStats.total === 1 && errState.mistakeStats.byLayer['记法'] === 1, JSON.stringify(errState.mistakeStats));
const noteFile = path.join(errDir, '错题本.md');
check('错题明细追加到 错题本.md', fs.existsSync(noteFile) && fs.readFileSync(noteFile, 'utf8').includes('She ___ (go) to school.'), noteFile);
const rMistake2 = await errTool.execute({ topic: 'if 嵌套', question: 'a|b 判真假', my_answer: '15>10 判假', correct: '真', layer: '乱写' }, { agent: { id: 'err' } });
check('未知错层记为未分层', typeof rMistake2 === 'string' && rMistake2.includes('未分层'), rMistake2.split('\n')[0]);
check('错题本表格转义竖线', fs.readFileSync(noteFile, 'utf8').includes('a｜b 判真假'));
const errCmd = errCalls.commands[0];
const rMistakes = await errCmd.handler({ rawInput: '/teaching mistakes', agent: { id: 'err' } });
check('mistakes 命令列出分层统计', rMistakes.kind === 'success' && rMistakes.text.includes('错题共 2 道') && rMistakes.text.includes('记法'), rMistakes.text.split('\n')[0]);
const rReview = await errCmd.handler({ rawInput: '/teaching review', agent: { id: 'err' } });
check('review 输出错题与出题要求', rReview.kind === 'success' && rReview.text.includes('最近错题') && rReview.text.includes('debt_resolved'), rReview.text.split('\n')[0]);

// 工具层按关键词销账
const rr = 'tool-resolve';
await tool('teaching_update').execute({ debt: '工具记的欠账' }, { agent: { id: rr } });
const rResTool = await tool('teaching_update').execute({ debt_resolved: '工具记的欠账', debt_note: '复测答对' }, { agent: { id: rr } });
check('teaching_update 按关键词销账', typeof rResTool === 'string' && rResTool.includes('已销账'), rResTool.split('\n')[0]);

// 注入头含最近错题
await run('/teaching debt 注入头测试欠账', rev);
await tool('teaching_mistake').execute({ topic: 'hair 不可数', question: 'two ___', layer: '概念' }, { agent: { id: rev } });
const revHeader = injectFor(rev);
check('注入头含待销欠账与最近错题', revHeader.includes('待销欠账') && revHeader.includes('最近错题'), (revHeader.match(/- 最近错题：.*/) || [''])[0]);
const rReviewEmpty = await cmd.handler({ rawInput: '/teaching review', agent: { id: 'empty-rev-sess' } });
check('没有欠账与错题时 review 明说', rReviewEmpty.kind === 'success' && rReviewEmpty.text.includes('没有待复习内容'), rReviewEmpty.text);

// ── 17. D 组：章末总复习校验 + 课程索引 + 日期提示 ──
const dDir = fs.mkdtempSync(path.join(os.tmpdir(), 'teaching-dgroup-'));
const dFile = path.join(os.tmpdir(), `teaching-dgroup-${process.pid}.json`);
fs.writeFileSync(dFile, JSON.stringify({ version: 1, sessions: { d1: { on: true, subject: '索引测试课', chapter: '第2章 索引', dataDir: dDir } } }), 'utf8');
const dCalls = { sections: [], commands: [], tools: [] };
const dCtx = { ...legacyCtx, systemPrompt: { section: sectionRegistrar(dCalls.sections) }, inject: (names, cb) => {
  if (names.includes('commands')) cb({ commands: { register: (d) => { dCalls.commands.push(d); return () => {}; } } });
  if (names.includes('tools')) cb({ tools: { register: (t) => { dCalls.tools.push(t); return () => {}; } } });
} };
const dMod = await import(pathToFileURL(ENTRY).href + '?dgroup=' + Date.now());
dMod.apply(dCtx, { statePath: dFile });
const dCmd = dCalls.commands[0];
const dRun = (rawInput, sid = 'd1') => dCmd.handler({ rawInput, agent: { id: sid } });

const rNoReview = await dRun('/teaching finish-chapter 第2章');
check('没有章末总复习时拒绝收章', rNoReview.kind === 'error' && rNoReview.text.includes('总复习'), rNoReview.text.split('\n')[0]);

fs.writeFileSync(path.join(dDir, '第1章-1.1-旧章-讲义.md'), '# 旧\n', 'utf8');
fs.writeFileSync(path.join(dDir, '第2章-1.1-索引-讲义.md'), '# 讲义\n', 'utf8');
fs.writeFileSync(path.join(dDir, '第2章-总复习.md'), '# 总复习\n', 'utf8');
fs.writeFileSync(path.join(dDir, '随手笔记.md'), '# 笔记\n', 'utf8');
const rWithReview = await dRun('/teaching finish-chapter 第2章 | 第3章');
check('总复习存在时允许收章并确认', rWithReview.kind === 'success' && rWithReview.text.includes('总复习文件存在'), rWithReview.text.split('\n')[0]);

const rForce = await dRun('/teaching finish-chapter 第4章 --force');
check('force 可跳过总复习检查', rForce.kind === 'success' && rForce.text.includes('force'), rForce.text.split('\n')[0]);

const rIndex = await dRun('/teaching index');
const idxFile = path.join(dDir, '课程索引.md');
check('index 命令生成课程索引', rIndex.kind === 'success' && fs.existsSync(idxFile), rIndex.text.split('\n')[0]);
const idxText = fs.existsSync(idxFile) ? fs.readFileSync(idxFile, 'utf8') : '';
check('索引按第N章分组', idxText.includes('## 第1章（1 个）') && idxText.includes('## 第2章（2 个）') && idxText.includes('未分章'), (idxText.match(/## .*/g) || []).join(' / '));
check('索引标注文件类型', idxText.includes('| 章总复习 |') && idxText.includes('| 讲义 |'));

fs.writeFileSync(path.join(dDir, '第5章-总复习.md'), '# 总复习5\n', 'utf8');
await dRun('/teaching finish-chapter 第5章');
check('状态落盘时自动重建索引', fs.readFileSync(idxFile, 'utf8').includes('第5章-总复习.md'));

const dHeader = dCalls.sections[0].text({ scope: { id: 'd1' } });
check('注入头出现资料索引行', dHeader.includes('课程索引.md'), (dHeader.match(/- 资料索引：.*/) || [''])[0]);

const dTool = dCalls.tools.find((t) => t.name === 'teaching_update');
const rToolBlocked = await dTool.execute({ finished_chapter: '第9章' }, { agent: { id: 'd1' } });
check('工具层收章同样校验总复习', typeof rToolBlocked === 'string' && rToolBlocked.includes('先别收章'), String(rToolBlocked).split('\n')[0]);
const rToolForce = await dTool.execute({ finished_chapter: '第9章', force: true }, { agent: { id: 'd1' } });
check('工具层 force 可跳过检查', typeof rToolForce === 'string' && rToolForce.includes('force'), String(rToolForce).split('\n')[0]);
check('工具 schema 暴露 force（boolean）', dTool.parameters.properties.force?.type === 'boolean', JSON.stringify(dTool.parameters.properties.force));

await dRun('/teaching exam 一个月以后');
const dHeader2 = dCalls.sections[0].text({ scope: { id: 'd1' } });
check('examDate 无法解析时给出明确提示', dHeader2.includes('无法解析'), (dHeader2.match(/- 考试：.*/) || [''])[0]);
try { fs.rmSync(dDir, { recursive: true, force: true }); fs.unlinkSync(dFile); } catch { /* 忽略 */ }

// ── 18. 出题硬门禁：没讲就出题必须被拒绝（v0.9.1）──
const gFile = path.join(os.tmpdir(), `teaching-gate-${process.pid}.json`);
fs.writeFileSync(gFile, JSON.stringify({
  version: 1,
  sessions: {
    g1: { on: true, subject: '编译原理', chapter: '第3章 词法分析', phase: 'teaching' },
    g2: { on: false, subject: '已关闭的课', phase: 'teaching' },
    g3: { on: true, subject: '' },
    g4: { on: true, subject: '编译原理', phase: 'briefing' },
  },
}), 'utf8');
const gGuards = [];
const gSections = [];
const gListeners = new Map();
const gEmit = (evt, payload) => { for (const fn of (gListeners.get(evt) || [])) { try { fn(payload); } catch { /* 忽略 */ } } };
const gCtx = {
  logger: { info: () => {}, warn: () => {}, error: () => {} },
  effect: (fn) => { try { fn(); } catch { /* 忽略 */ } return () => {}; },
  systemPrompt: { section: (o) => { gSections.push(o); return () => {}; } },
  inject: (names, cb) => {
    if (names.includes('commands')) cb({ commands: { register: () => () => {} } });
    if (names.includes('tools')) cb({ tools: { register: () => () => {}, guard: (fn) => { gGuards.push(fn); return () => {}; } } });
  },
  on: (evt, fn) => { const a = gListeners.get(evt) || []; a.push(fn); gListeners.set(evt, a); return () => {}; },
  set: () => {},
};
const gMod = await import(pathToFileURL(ENTRY).href + '?gate=' + Date.now());
gMod.apply(gCtx, { statePath: gFile });
check('门禁：注册了 tools.guard', gGuards.length === 1, `guards=${gGuards.length}`);
const gate = gGuards[0] || (() => undefined);
const askExec = (sid, name = 'ask_user_question') => ({ name, agent: { id: sid }, arguments: { questions: [{ id: 'q1', question: '下列说法正确的是？' }] } });
const stream = (sid, turn, text, kind = 'text-delta') => {
  const attemptId = `a-${sid}-${turn}-${Math.random().toString(36).slice(2, 7)}`;
  gEmit('agent/assistant-stream', { agent: { id: sid }, frame: { type: 'start', attemptId, revision: 1, turn, step: 0 } });
  if (text) gEmit('agent/assistant-stream', { agent: { id: sid }, frame: { type: 'chunk', attemptId, revision: 1, index: 0, time: 0, chunk: { type: kind, index: 0, text } } });
  gEmit('agent/assistant-stream', { agent: { id: sid }, frame: { type: 'end', attemptId, revision: 1, index: 0, outcome: { kind: 'committed', eventType: 'assistant/message', seq: 1 } } });
};
/** 模拟学生发一条新消息：v0.10 门禁按学生消息清空讲解缓存 */
const userSay = (sid, text = '继续') => {
  gEmit('agent/inbox/claimed', { agent: { id: sid }, message: { content: [{ type: 'text', text }] } });
};
const gLong = '正规式是描述词法单元的模式。它由三种基本运算构成：连接、选择、闭包。首先，符号 a 本身就是一个正规式，表示集合里只有字符串 a。其次，如果 r 与 s 都是正规式，那么 r 接 s 也是正规式，表示先把 r 匹配的串和 s 匹配的串接起来。第三，r 或 s 也是正规式，表示两者任取其一。第四，r 的星号闭包表示把 r 重复零次或多次。为什么这样定义？因为词法分析器本质上是有限自动机，而正规式恰好与有限自动机等价，所以用它来描述标识符、数字这类模式最自然。例如 (a|b)*abb 表示所有由 a、b 组成且以 abb 结尾的串。';
stream('g1', 1, '');              // 学生刚发消息，模型一个字没写
const gDeny1 = gate(askExec('g1'));
check('门禁：没写讲解就出题，被拒绝', typeof gDeny1 === 'string' && gDeny1.includes('出题被拒绝'), String(gDeny1).slice(0, 40));
stream('g1', 1, gLong);           // 后续 assistant 消息补讲：v0.10 跨消息累计
const gAllow1 = gate(askExec('g1'));
check('门禁：补出讲解后放行（跨消息累计）', gAllow1 === undefined, String(gAllow1).slice(0, 40));
const gAllow2 = gate(askExec('g1'));
check('门禁：同一讲次已放行后可连出', gAllow2 === undefined, String(gAllow2).slice(0, 40));
userSay('g1', '继续');            // 学生发新消息 → 上一讲作废
const gDeny2 = gate(askExec('g1'));
check('门禁：学生发新消息后没讲又出题，再次拒绝', typeof gDeny2 === 'string' && gDeny2.includes('出题被拒绝'), String(gDeny2).slice(0, 40));
stream('g1', 3, '这是一段足够长的讲课正文');
const gShort = gate(askExec('g1'));
check('门禁：正文不足 300 字且无结构信号仍拒绝', typeof gShort === 'string' && gShort.includes('出题被拒绝'), String(gShort).slice(0, 40));
// v0.10 信号制：不再强求「是什么 + 为什么」两个词（真机上 1079 字被连拒 5 次）
const gGradingOnly = '答对了，你选 B 是对的。上一题你错在把筛选区和改写区看反了，这里再确认一次：先看 if 在 for 前面还是后面，前面的要配 else，后面的只做过滤。下一题来了，请判断下面这段代码输出什么。注意看清变量名，别把 m 和 n 混在一起，这类错误在考试里最容易丢分，务必逐字对照。另外提醒你，做完别急着交，先把两栏写在纸上再对号入座，养成习惯后考场上就不会慌，也不会因为粗心白白扣分。';
const gGradingLong = gGradingOnly + '以上都是批改和考试技巧，没有定义，也没有推导。'.repeat(6);
stream('g1', 4, gGradingLong);
const gLongOK = gate(askExec('g1'));
check('门禁：正文够 300 字即放行（信号制，关键词不强制）', gLongOK === undefined, String(gLongOK).slice(0, 40));
// v0.10 题干检查：代码必须在正文代码框里，不许塞进题干
const gCardCode = gate({ name: 'ask_user_question', agent: { id: 'g1' }, arguments: { questions: [{ id: 'q1', question: '下面的代码输出什么？\nprint(1 + 1)', options: [{ label: 'A' }, { label: 'B' }] }] } });
check('门禁：题干塞多行代码，被拒绝', typeof gCardCode === 'string' && gCardCode.includes('代码'), String(gCardCode).slice(0, 50));
const gCardHint = gate({ name: 'ask_user_question', agent: { id: 'g1' }, arguments: { questions: [{ id: 'q1', question: '下列说法正确的是？', options: [{ label: 'A', description: '推荐选这个' }, { label: 'B' }] }] } });
check('门禁：选项含「推荐」，被拒绝', typeof gCardHint === 'string' && gCardHint.includes('推荐'), String(gCardHint).slice(0, 50));
userSay('g1', '继续');
stream('g1', 4, gLong, 'reasoning-delta');
const gThink = gate(askExec('g1'));
check('门禁：思考过程不算讲解', typeof gThink === 'string', String(gThink).slice(0, 40));
stream('g2', 1, '');
check('门禁：教师模式关闭时不拦', gate(askExec('g2')) === undefined);
stream('g3', 1, '');
check('阶段闸门：没开课（无课题）出教学内容题，被拒绝', typeof gate(askExec('g3')) === 'string');
const gAsk3 = gate({ name: 'ask_user_question', agent: { id: 'g3' }, arguments: { questions: [{ id: 'q1', question: '学完这门课你想达到什么目标？', options: [{ label: '应付考试' }, { label: '打基础' }] }] } });
check('阶段闸门：开课前问询卡片放行', gAsk3 === undefined, String(gAsk3).slice(0, 40));
stream('g4', 1, gLong);
check('阶段闸门：备课阶段即使讲了也不许出题', typeof gate(askExec('g4')) === 'string');
userSay('g1', '继续');
stream('g1', 5, '');
check('门禁：非出题工具不拦', gate(askExec('g1', 'teaching_update')) === undefined);
// 兜底：万一 provider 或转接层不走流式增量、只在 block-end 给整块文本，
// 不能被误判成"没讲"而把出题全部拦死
const streamBlock = (sid, turn, text) => {
  const attemptId = `b-${sid}-${turn}-${Math.random().toString(36).slice(2, 7)}`;
  gEmit('agent/assistant-stream', { agent: { id: sid }, frame: { type: 'start', attemptId, revision: 1, turn, step: 0 } });
  gEmit('agent/assistant-stream', { agent: { id: sid }, frame: { type: 'chunk', attemptId, revision: 1, index: 0, time: 0, chunk: { type: 'block-end', index: 0, block: { type: 'text', text } } } });
  gEmit('agent/assistant-stream', { agent: { id: sid }, frame: { type: 'end', attemptId, revision: 1, index: 0, outcome: { kind: 'committed', eventType: 'assistant/message', seq: 1 } } });
};
userSay('g1', '继续');
streamBlock('g1', 6, gLong);
const gBlock = gate(askExec('g1'));
check('门禁：只给 block-end 整块文本也算讲了', gBlock === undefined, String(gBlock).slice(0, 40));
// ── 18b. 纯文本出题的事后纠偏（v0.9.6）──
// 英语课的单元卷、ABCD 选择题是模型直接写在正文里的，不经过任何工具调用，
// examGate 拦不住；这里验证「判定 → 记账 → 下一轮强制补讲 → 只纠一次」。
const gQuizText = '一、单项选择（每题2分）\n1. — Where is your pen? — It is in my bag.\nA. in  B. on  C. under  D. behind\n2. She ___ to school every day.\nA. go  B. goes  C. going  D. gone\n3. — ___ do you go to school? — By bike.\nA. What  B. How  C. When  D. Where\n4. There ___ some milk in the glass.\nA. are  B. is  C. be  D. have\n5. Look! The boys ___ football now.\nA. play  B. plays  C. are playing  D. played\n6. He is good ___ English.\nA. at  B. in  C. on  D. for\n把答案写在下面。';
userSay('g1', '继续');            // 学生发新消息，清掉上一段讲解
stream('g1', 7, gQuizText);
const gAfterQuiz = JSON.parse(fs.readFileSync(gFile, 'utf8'));
const gDump = gAfterQuiz.sessions && gAfterQuiz.sessions.g1 && gAfterQuiz.sessions.g1.quizDump;
check('纠偏：纯文本出题被记账', !!gDump, JSON.stringify(gDump));
const gSec = gSections[0];
const gFix1 = gSec.text({ scope: { id: 'g1' } });
check('纠偏：下一轮开头要求那批题作废重讲', gFix1.includes('上一轮违规') && gFix1.includes('作废'), (gFix1.match(/【教师模式·上一轮违规[^\n]*/) || [''])[0]);
const gFix2 = gSec.text({ scope: { id: 'g1' } });
check('纠偏：只纠一次，不重复念', !gFix2.includes('上一轮违规'), '');
const gAfterFix = JSON.parse(fs.readFileSync(gFile, 'utf8'));
check('纠偏：注入后状态里的记账已清空', !(gAfterFix.sessions.g1 && gAfterFix.sessions.g1.quizDump), JSON.stringify(gAfterFix.sessions.g1 && gAfterFix.sessions.g1.quizDump));
try { fs.unlinkSync(gFile); } catch { /* 忽略 */ }

// ── 18. 接力修复（2026-11-03）：归一化课题 + 目录沿用 + 关态线索 + 空壳清理 ──
const relayRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'teaching-relay-'));
const relayProj = path.join(relayRoot, 'projects', 'Python', '03-产出');
fs.mkdirSync(relayProj, { recursive: true });
const rFile = path.join(os.tmpdir(), `teaching-relay-${process.pid}.json`);
const relayCalls = { sections: [], commands: [], tools: [] };
const relayCtx = { ...legacyCtx, systemPrompt: { section: sectionRegistrar(relayCalls.sections) }, inject: (names, cb) => {
  if (names.includes('commands')) cb({ commands: { register: (d) => { relayCalls.commands.push(d); return () => {}; } } });
  if (names.includes('tools')) cb({ tools: { register: (t) => { relayCalls.tools.push(t); return () => {}; } } });
} };
const relayMod = await import(pathToFileURL(ENTRY).href + '?relay=' + Date.now());
relayMod.apply(relayCtx, { statePath: rFile });
const rCmd = relayCalls.commands[0];
const rRun = (rawInput, sid) => rCmd.handler({ rawInput, agent: { id: sid } });
const rTool = (n) => relayCalls.tools.find((t) => t.name === n);
const relaySetup = rTool('teaching_setup');
const rRead = () => JSON.parse(fs.readFileSync(rFile, 'utf8')).sessions || {};

check('[接力] 归一化课题：上下册/括号注释不影响"同一门课"',
  relayMod.normSubject('初中英语（牛津译林版七年级下册）') === relayMod.normSubject('初中英语（牛津译林版七年级）'),
  relayMod.normSubject('初中英语（牛津译林版七年级下册）'));
check('[接力] suggestDataDir 在 projects 下找到已存在的同名课目录',
  relayMod.suggestDataDir(relayRoot, 'Python（下册）') === relayProj,
  relayMod.suggestDataDir(relayRoot, 'Python（下册）'));

// A 会话：正常开课、备课确认、记进度
const relayA = 'relay-a';
await relaySetup.execute({ subject: 'Python', material: '吴保俊《Python自学》', material_mode: 'textbook' }, { agent: { id: relayA }, header: { cwd: relayRoot } });
await rTool('teaching_prepare').execute({ confirmed: true, note: '教材齐、真题2套、路线已定' }, { agent: { id: relayA } });
fs.mkdirSync(relayProj, { recursive: true });
fs.writeFileSync(path.join(relayProj, '7.1 列表基础-复习资料.md'), '# 7.1 复习资料\n', 'utf8');
await rTool('teaching_update').execute({ progress: '第7章 列表与元组', finished_section: '7.1 列表基础' }, { agent: { id: relayA } });
await rRun('/teaching on', relayA);

// B 会话（接力）：课题名换个叫法，必须沿用同一目录、进度自动合并
const relayB = 'relay-b';
const rB = await relaySetup.execute({ subject: 'Python（2026新版下册）' }, { agent: { id: relayB }, header: { cwd: relayRoot } });
check('[接力] 课题名被改写时沿用已存在的资料目录（不另建空目录）',
  String(rB).includes('自动沿用') && rRead()[relayB].dataDir === relayProj,
  String(rB).split('\n')[1] || '');
check('[接力] 两会话进度自动合并（新会话不是空账）',
  (rRead()[relayB].learnedSections || []).includes('7.1 列表基础')
  && (rRead()[relayA].learnedSections || []).includes('7.1 列表基础'),
  JSON.stringify(rRead()[relayB].learnedSections || []));
// 同一门课再 setup 一次（换叫法）不能把备课结论打回 pending
await relaySetup.execute({ subject: 'Python（2024修订版）' }, { agent: { id: relayA }, header: { cwd: relayRoot } });
check('[接力] 同一门课换叫法不重置备课结论', rRead()[relayA].prep === 'confirmed', String(rRead()[relayA].prep));

// 全新会话（无状态）：注入里要出现"本工作区已有的课"线索
const relaySection = relayCalls.sections[0].text({ scope: { id: 'relay-fresh' } });
check('[接力] 未开课的新会话注入"已有的课"线索',
  relaySection.includes('本工作区已有的课') && relaySection.includes('Python'),
  (relaySection.match(/- 「Python」.*/) || [''])[0]);

// 空壳清理：默认只预览，-f 才动手（先落盘一条空壳记录：无课题/无目录/无进度）
await rRun('/teaching on', 'prune-shell');
const rDry = await rRun('/teaching prune', relayA);
check('[清理] 默认只预览不动手', rDry.kind === 'success' && String(rDry.text).includes('将清理') && !!rRead()['prune-shell'], String(rDry.text).slice(0, 40));
const droppedShell = await rRun('/teaching prune -f', relayA);
check('[清理] -f 执行后空壳消失、有课题的课保留',
  !rRead()['prune-shell'] && !!rRead()[relayA] && !!rRead()[relayB],
  String(droppedShell.text).slice(0, 40));

// [接力] 状态库键名是 session-<uuid>：显示要去前缀，link 要能用裸前 8 位命中
check('[接力] shortId 去掉 session- 前缀',
  relayMod.shortId('session-8aeef709-1fba-48d2-96fe-b5d324b42135') === '8aeef709'
  && relayMod.shortId('relay-a') === 'relay-a',
  relayMod.shortId('session-8aeef709-1fba-48d2-96fe-b5d324b42135'));
const linkFile = path.join(os.tmpdir(), `teaching-link-${process.pid}.json`);
const linkSid = 'session-aaaa1111-2222-3333-4444-555566667777';
fs.writeFileSync(linkFile, JSON.stringify({
  sessions: {
    [linkSid]: {
      on: true, subject: '汇编语言', chapter: '第3章', learnedSections: ['3.1'],
      debts: [], recentMistakes: [], finished: [], learnedChapters: [],
      mistakeStats: { total: 0, byLayer: {} }, prep: 'confirmed', updatedAt: new Date().toISOString(),
    },
    'link-me': {
      on: false, subject: '', chapter: '', learnedSections: [],
      debts: [], recentMistakes: [], finished: [], learnedChapters: [],
      mistakeStats: { total: 0, byLayer: {} }, updatedAt: new Date().toISOString(),
    },
  },
}, null, 2));
const linkCalls = { sections: [], commands: [], tools: [] };
const linkCtx = {
  ...legacyCtx,
  systemPrompt: { section: sectionRegistrar(linkCalls.sections) },
  inject: (names, cb) => {
    if (names.includes('commands')) cb({ commands: { register: (d) => { linkCalls.commands.push(d); return () => {}; } } });
    if (names.includes('tools')) cb({ tools: { register: (t) => { linkCalls.tools.push(t); return () => {}; } } });
  },
};
const linkMod = await import(pathToFileURL(ENTRY).href + '?link=' + Date.now());
linkMod.apply(linkCtx, { statePath: linkFile });
const lRes = await linkCalls.commands[0].handler({ rawInput: '/teaching link aaaa1111', agent: { id: 'link-me' } });
const lAfter = JSON.parse(fs.readFileSync(linkFile, 'utf8')).sessions['link-me'];
check('[接力] /teaching link 能用裸前 8 位命中带 session- 前缀的会话',
  lAfter.subject === '汇编语言' && lAfter.chapter === '第3章' && String(lRes.text).includes('aaaa1111'),
  `${lAfter.subject || '-'} / ${lAfter.chapter || '-'} / ${String(lRes.text).slice(0, 40)}`);
try { fs.unlinkSync(linkFile); } catch { /* 忽略 */ }

// [并账] 同一条欠账在两会话里是「内容相同、引用不同」的对象：合并不能翻倍，且必须幂等
const syncFile = path.join(os.tmpdir(), `teaching-sync-${process.pid}.json`);
const mkDebt = (status, resolvedAt = '') => ({ id: '1', text: '通分时漏乘分子', status, addedAt: '2026-10-01T00:00:00.000Z', resolvedAt, note: '' });
const mkSess = (subject, debts, updatedAt) => ({
  on: true, subject, chapter: '第1章', learnedSections: ['1.1'], debts,
  recentMistakes: [], finished: [], learnedChapters: [],
  mistakeStats: { total: 0, byLayer: {} }, updatedAt,
});
fs.writeFileSync(syncFile, JSON.stringify({
  sessions: {
    'session-sync-a-1111': mkSess('分数运算', [mkDebt('open')], '2026-10-01T00:00:00.000Z'),
    'session-sync-b-2222': mkSess('分数运算（下册）', [mkDebt('open')], '2026-10-02T00:00:00.000Z'),
    'session-sync-c-3333': mkSess('化学', [mkDebt('resolved', '2026-10-03T00:00:00.000Z')], '2026-10-03T00:00:00.000Z'),
  },
}, null, 2));
const mkPlugin = async (tag) => {
  const basket = { sections: [], commands: [], tools: [] };
  const ctx = {
    ...legacyCtx,
    systemPrompt: { section: sectionRegistrar(basket.sections) },
    inject: (names, cb) => {
      if (names.includes('commands')) cb({ commands: { register: (d) => { basket.commands.push(d); return () => {}; } } });
      if (names.includes('tools')) cb({ tools: { register: (t) => { basket.tools.push(t); return () => {}; } } });
    },
  };
  const mod = await import(pathToFileURL(ENTRY).href + `?${tag}=` + Date.now());
  mod.apply(ctx, { statePath: syncFile });
  return { mod, basket };
};
const syncRead = () => JSON.parse(fs.readFileSync(syncFile, 'utf8')).sessions;
const firstRun = await mkPlugin('sync1');
const once = syncRead();
check('[并账] 两会话里同一笔欠账只合并成 1 条（不能按引用翻倍）',
  once['session-sync-a-1111'].debts.length === 1 && once['session-sync-b-2222'].debts.length === 1,
  `a=${once['session-sync-a-1111'].debts.length} b=${once['session-sync-b-2222'].debts.length}`);
check('[并账] 换叫法（分数运算 / 分数运算（下册））仍是同一门课',
  once['session-sync-a-1111'].subject === once['session-sync-b-2222'].subject,
  `${once['session-sync-a-1111'].subject} vs ${once['session-sync-b-2222'].subject}`);
const syncedHint = firstRun.basket.sections[0].text({ scope: { id: 'hint-fresh' } });
const chemLine = (syncedHint.match(/- 「化学」.*/) || [''])[0];
check('[接力] 全已销的课在接力线索里不算"欠账未销"', !!chemLine && !chemLine.includes('欠账未销'), chemLine || '（线索里没有化学）');
// 新手教程（v0.9.5）：Host 侧硬指令，每个会话只出一次
const welcomeFirst = firstRun.basket.sections[0].text({ scope: { id: 'welcome-fresh' } });
const welcomeAgain = firstRun.basket.sections[0].text({ scope: { id: 'welcome-fresh' } });
const welcomeOther = firstRun.basket.sections[0].text({ scope: { id: 'welcome-other' } });
check('[新手教程] 首次注入含"原话输出三句"硬指令',
  welcomeFirst.includes('本轮必做') && welcomeFirst.includes('想上课就说「开启教师模式」'),
  welcomeFirst.slice(-90));
check('[新手教程] 同一会话第二次不再出现', !welcomeAgain.includes('本轮必做'), '');
check('[新手教程] 换会话仍各一次', welcomeOther.includes('本轮必做'), '');
await mkPlugin('sync2');
const twice = syncRead();
check('[并账] 第二次启动再同步，欠账条数不变（幂等）',
  twice['session-sync-a-1111'].debts.length === 1,
  `第二次=${twice['session-sync-a-1111'].debts.length}`);
try { fs.unlinkSync(syncFile); } catch { /* 忽略 */ }
try { fs.unlinkSync(rFile); } catch { /* 忽略 */ }

// 清理临时文件
for (const f of [legacyFile, errFile]) { try { fs.unlinkSync(f); } catch { /* 忽略 */ } }
try { fs.rmSync(errDir, { recursive: true, force: true }); } catch { /* 忽略 */ }

// ── 汇总 ──
console.log('\n' + '─'.repeat(40));
console.log(`结果：${pass}/${pass + fail} 通过${fail ? `，${fail} 失败` : ''}`);
console.log('\n插件自报日志：');
for (const l of calls.logs) console.log('  · ' + l);

try { fs.unlinkSync(TMP_STATE); } catch { /* 忽略 */ }
process.exit(fail ? 1 : 0);
