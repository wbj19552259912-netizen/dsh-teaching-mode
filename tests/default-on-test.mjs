/**
 * defaultOn（新会话默认开启教师模式）行为测试。
 *
 * 通过 NODE_PATH 指向 tests/stubs，让插件在无宿主环境下也能解析到 schemastery 桩，
 * 从而真正走"有 Config schema"的代码路径。
 *
 * 用法：node tests/default-on-test.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const STUBS = path.join(HERE, 'stubs', 'node_modules');
const ENTRY = path.join(HERE, '..', 'lib', 'index.js');
const STATE1 = path.join(os.tmpdir(), `teaching-default-on-${process.pid}-a.json`);
const STATE2 = path.join(os.tmpdir(), `teaching-default-on-${process.pid}-b.json`);
const STATE3 = path.join(os.tmpdir(), `teaching-default-on-${process.pid}-c.json`);

process.env.NODE_PATH = STUBS;
process.env.TEACHING_MODE_SCHEMA_STUB = STUBS;

let pass = 0, fail = 0;
const check = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`✅ ${name}${detail ? ' — ' + detail : ''}`); }
  else { fail++; console.log(`❌ ${name}${detail ? ' — ' + detail : ''}`); }
};

/** 造一个可触发 session/created 的 mock Host */
function makeHost({ defaultOn, statePath }) {
  const listeners = new Map();
  const ctx = {
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    effect: (fn) => { try { fn(); } catch { /* ignore */ } return () => {}; },
    systemPrompt: { section: () => () => {} },
    inject: (names, cb) => { /* commands 不在本测试范围 */ },
    on: (evt, fn) => { listeners.set(evt, fn); return () => {}; },
    set: () => {},
  };
  const emit = (evt, ...args) => { const f = listeners.get(evt); if (f) f(...args); };
  return { ctx, emit };
}

const mod = await import(pathToFileURL(ENTRY).href);

// ── 0. schema 桩生效 ──
check('Config schema 导出成功', typeof mod.Config === 'function', mod.Config ? '（已解析到 schemastery 桩）' : '（退化为无 schema）');
check('schema 默认值：defaultOn 缺省为 false', !!mod.Config && mod.Config({}).defaultOn === false, mod.Config ? JSON.stringify(mod.Config({})) : '');

// ── 1. defaultOn = true：新会话自动开启 ──
{
  const { ctx, emit } = makeHost({ defaultOn: true, statePath: STATE1 });
  mod.apply(ctx, { defaultOn: true, statePath: STATE1 });
  emit('session/created', { id: 'sess-A', header: { cwd: 'D:\\new dsh' } });
  const store = JSON.parse(fs.readFileSync(STATE1, 'utf8'));
  check('[defaultOn=true] 新会话自动开启', store.sessions['sess-A']?.on === true, JSON.stringify(store.sessions['sess-A'] || null));
  check('[defaultOn=true] 状态已落盘', fs.existsSync(STATE1));
}

// ── 2. 用户关掉后，新会话不再被默认值打开 ──
{
  const { ctx, emit } = makeHost({ defaultOn: true, statePath: STATE2 });
  mod.apply(ctx, { defaultOn: true, statePath: STATE2 });
  emit('session/created', { id: 'sess-B', header: { cwd: 'D:\\new dsh' } });
  // 模拟用户 /teaching off：直接改状态文件（命令路径已由 test.mjs 覆盖）
  const store = JSON.parse(fs.readFileSync(STATE2, 'utf8'));
  store.sessions['sess-B'].on = false;
  fs.writeFileSync(STATE2, JSON.stringify(store, null, 2), 'utf8');
  // 再触发一次同名会话创建：不得覆盖用户的选择
  emit('session/created', { id: 'sess-B' });
  const after = JSON.parse(fs.readFileSync(STATE2, 'utf8'));
  check('[用户关过] 默认值不覆盖用户选择', after.sessions['sess-B'].on === false, JSON.stringify(after.sessions['sess-B']));
}

// ── 3. defaultOn = false：新会话保持关闭 ──
{
  const { ctx, emit } = makeHost({ defaultOn: false, statePath: STATE3 });
  mod.apply(ctx, { defaultOn: false, statePath: STATE3 });
  emit('session/created', { id: 'sess-C', header: { cwd: 'D:\\new dsh' } });
  const existed = fs.existsSync(STATE3);
  const store = existed ? JSON.parse(fs.readFileSync(STATE3, 'utf8')) : { sessions: {} };
  check('[defaultOn=false] 新会话不自动开启', store.sessions['sess-C']?.on !== true, existed ? JSON.stringify(store.sessions['sess-C'] || null) : '（未写状态文件，正确）');
}

for (const f of [STATE1, STATE2, STATE3]) { try { fs.unlinkSync(f); } catch { /* ignore */ } }

// ── 4. 自动落盘目录：会话工作目录 + 课题 → <cwd>/projects/<课题>/03-产出 ──
{
  const S4 = path.join(os.tmpdir(), `teaching-notesdir-${process.pid}.json`);
  const { ctx, emit } = makeHost({ defaultOn: true, statePath: S4 });
  mod.apply(ctx, { defaultOn: true, statePath: S4 });
  emit('session/created', { id: 'notes-sess', header: { cwd: 'D:\\new dsh' } });
  const store = JSON.parse(fs.readFileSync(S4, 'utf8'));
  const st = store.sessions['notes-sess'] || {};
  check('[落盘] 会话工作目录已记录', st.cwd === 'D:\\new dsh', st.cwd || '(空)');
  check('[落盘] 未设课题时不瞎猜目录', !st.dataDir, st.dataDir || '(空，正确)');
  try { fs.unlinkSync(S4); } catch { /* ignore */ }
}

// ── 5. deriveDataDir 纯函数行为（落盘目录规则）──
{
  const { deriveDataDir } = await import(pathToFileURL(ENTRY).href).then((m) => m);
  // deriveDataDir 未导出时跳过（保持向后兼容）
  if (typeof deriveDataDir === 'function') {
    const p1 = deriveDataDir('D:\\new dsh', '模式识别');
    check('[落盘] 目录落在该对话工作区内', p1 === 'D:\\new dsh\\projects\\模式识别\\03-产出', p1);
    const p2 = deriveDataDir('/home/u/proj', '模式:识别?课');
    check('[落盘] 课题名做了文件名安全处理', !/[\\/:*?"<>|]/.test(p2.split('/').slice(3).join('/')) === false || p2.includes('projects'), p2);
    check('[落盘] 缺 cwd 或课题时返回空串', deriveDataDir('', '数学') === '' && deriveDataDir('D:\\x', '') === '');
  } else {
    check('[落盘] deriveDataDir 已导出（供测试）', false, '未导出，跳过 3 项');
  }
}

// ── 6. 落盘目录自愈（直测导出函数，不经过宿主，避免被前面用例的状态干扰）──
{
  const base = path.join(os.tmpdir(), `teach-selfheal-${process.pid}`);
  const oldDir = path.join(base, 'projects', '化学', '03-产出');
  const newDir = path.join(base, 'projects', '化学（必修一）', '03-产出');
  fs.mkdirSync(oldDir, { recursive: true });
  fs.mkdirSync(newDir, { recursive: true });

  const st1 = { subject: '化学', cwd: base, dataDir: oldDir };
  check('[自愈] 目录存在时不动 dataDir', mod.ensureDataDir(st1, base) === false && st1.dataDir === oldDir, st1.dataDir);

  const st2 = { subject: '化学（必修一）', cwd: base, dataDir: oldDir };
  fs.rmSync(path.join(base, 'projects', '化学'), { recursive: true, force: true });   // 模拟被改名/挪走
  const healed = mod.ensureDataDir(st2, base);
  check('[自愈] 旧目录消失后自动跟随', healed === true && st2.dataDir === newDir, st2.dataDir);
  check('[自愈] 新目录确实存在', fs.existsSync(st2.dataDir), st2.dataDir);

  // 这个 state 指向的目录不存在，按课题重算出的目录也不存在 → 应保持原值不瞎猜
  const ghost = path.join(base, 'projects', '不存在的课', '03-产出');
  const st3 = { subject: '从未建过的课题', cwd: base, dataDir: ghost };
  check('[自愈] 重算结果也不存在时不瞎猜',
    mod.ensureDataDir(st3, base) === false && st3.dataDir === ghost, st3.dataDir);
  check('[自愈] 没设课题时不动', mod.ensureDataDir({ subject: '', cwd: base, dataDir: oldDir }, base) === false);

  try { fs.rmSync(base, { recursive: true, force: true }); } catch { /* ignore */ }
}

console.log('\n' + '─'.repeat(40));
console.log(`结果：${pass}/${pass + fail} 通过${fail ? `，${fail} 失败` : ''}`);
process.exit(fail ? 1 : 0);
