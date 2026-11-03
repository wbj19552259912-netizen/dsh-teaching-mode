/**
 * 客户端半边测试：在 Node 里模拟浏览器环境，验证 lib/client.js 这个"手写客户端模块"能否被 DSH 加载。
 *
 * 模拟三样东西：
 *   - window.__ModuleLoader__.load：DSH 客户端模块协议入口
 *   - require("react")：宿主提供的 React（这里给一个最小实现）
 *   - ctx.slots / ctx.get：客户端服务
 * 用法：node tests/client-test.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLIENT = path.join(HERE, '..', 'lib', 'client.js');

let pass = 0, fail = 0;
const results = [];
function check(name, cond, detail = '') {
  if (cond) { pass++; results.push({ name, ok: true, detail }); console.log(`✅ ${name}${detail ? ' — ' + detail : ''}`); }
  else { fail++; results.push({ name, ok: false, detail }); console.log(`❌ ${name}${detail ? ' — ' + detail : ''}`); }
}

// ── 最小 React 实现（只需 createElement 能产出可检查的树）──
function createElement(type, props, ...children) {
  return { $$typeof: 'element', type, props: { ...(props || {}), children: children.length <= 1 ? children[0] : children } };
}
const fakeReact = {
  createElement,
  Fragment: 'Fragment',
  // 设置页组件用到 hooks；这里给最小实现，以便测试能展开它
  useState: (init) => [typeof init === 'function' ? init() : init, () => {}],
  useEffect: () => {},
  useMemo: (fn) => fn(),
  useRef: (v) => ({ current: v }),
};

// ── 捕获 DSH 客户端加载协议 ──
const loaded = [];
const sandbox = {
  window: {
    __ModuleLoader__: {
      load: (spec) => { loaded.push(spec); },
    },
  },
  console,
};
sandbox.globalThis = sandbox;
vm.createContext(sandbox);

const src = fs.readFileSync(CLIENT, 'utf8');
try {
  vm.runInContext(src, sandbox, { filename: 'client.js' });
  check('客户端文件可在浏览器上下文执行', true);
} catch (e) {
  check('客户端文件可在浏览器上下文执行', false, e.message);
}

// ── 协议层 ──
check('调用了 window.__ModuleLoader__.load', loaded.length === 1, `load 调用 ${loaded.length} 次`);
const spec = loaded[0] || {};
check('声明了模块 id', spec.id === 'dsh-teaching-mode', String(spec.id));
check('提供了 factory 函数', typeof spec.factory === 'function');

const requireMock = (name) => {
  if (name === 'react') return fakeReact;
  if (name === 'react/jsx-runtime') return { jsx: createElement, jsxs: createElement };
  throw new Error('客户端只应 require react，但要求了: ' + name);
};

const mod = spec.factory ? spec.factory(requireMock) : {};
check('factory 返回插件模块', !!mod && typeof mod === 'object');
check('模块导出 name', mod.name === 'dsh-teaching-mode', String(mod.name));
check('模块导出 apply', typeof mod.apply === 'function');
check('模块声明 inject', Array.isArray(mod.inject), JSON.stringify(mod.inject));

// ── 挂载行为 ──
const regs = [];
const ctx = {
  logger: { info: () => {} },
  get: (k) => (k === 'locale' ? { getLocale: () => ({ id: 'zh' }) } : undefined),
  effect: (fn, label) => { try { fn(); } catch { /* ignore */ } return () => {}; },
  slots: {
    register: (def) => { regs.push(def); return () => {}; },
  },
};

try {
  mod.apply(ctx);
  check('apply 执行无异常', true);
} catch (e) {
  check('apply 执行无异常', false, e.message);
}

check('注册了 3 个 slot（对话页签 + 设置页 + 新手引导条）', regs.length === 3, `实际 ${regs.length}`);
const reg = regs.find((r) => r.name === 'conversation.view') || {};
const regSettings = regs.find((r) => r.name === 'settings.section') || {};
const regDock = regs.find((r) => r.name === 'conversation.input.dock') || {};
check('挂着 conversation.view 页签', !!reg.name, String(reg.name));
check('挂着 settings.section 设置页', !!regSettings.name, String(regSettings.name));
check('挂着 conversation.input.dock 新手引导条', !!regDock.name, String(regDock.name));
const dockNode = typeof regDock.component === 'function' ? regDock.component({}) : null;
check('引导条首次渲染出可见内容', !!dockNode, dockNode ? 'yes' : 'null');
check('提供了 component', typeof reg.component === 'function');
check('提供了 label', typeof reg.label === 'function', typeof reg.label === 'function' ? String(reg.label()) : '');

// ── 组件可渲染 ──
let tree = null;
try {
  tree = reg.component ? reg.component({ services: { locale: { getLocale: () => ({ id: 'zh' }) } } }) : null;
  check('component 可渲染出元素树', !!tree && tree.$$typeof === 'element', tree ? String(tree.type?.name || tree.type) : '');
} catch (e) {
  check('component 可渲染出元素树', false, e.message);
}

// 深度检查：树里应含标题与命令用法
// 注意：mock React 不渲染，函数组件返回的仍是一棵元素树；
// 因此遍历时要"展开"函数组件（调用它拿返回的子树）才能取到文本。
function collectText(node, acc = []) {
  if (node == null || node === false) return acc;
  if (typeof node === 'string' || typeof node === 'number') { acc.push(String(node)); return acc; }
  if (Array.isArray(node)) { for (const n of node) collectText(n, acc); return acc; }
  if (typeof node === 'object' && node.$$typeof === 'element') {
    if (typeof node.type === 'function') {
      try { collectText(node.type(node.props || {}), acc); } catch { /* 跳过无法展开的组件 */ }
      return acc;
    }
    if (node.props) collectText(node.props.children, acc);
  }
  return acc;
}
const texts = collectText(tree);
const joined = texts.join(' | ');
check('面板含中文标题', joined.includes('教师模式'), joined.slice(0, 60));
check('面板含关键铁律（讲透/条数/不抢跑/作业）', joined.includes('讲透') && joined.includes('条数') && joined.includes('不抢跑') && joined.includes('不配检验题'));
check('面板含命令用法', joined.includes('/teaching on'));
check('面板含三级粒度说明', joined.includes('小知识点'));

// ── 降级：没有 slots 服务时不应抛错 ──
let degradeOk = true;
try { mod.apply({ logger: { info: () => {} }, get: () => undefined }); }
catch { degradeOk = false; }
check('缺少 slots 服务时优雅降级（不抛错）', degradeOk);

// ── 设置页也检查一遍（简介 + 开关 + 用法）──
let settingsTree = null;
try {
  settingsTree = regSettings.component ? regSettings.component({ services: { locale: { getLocale: () => ({ id: 'zh' }) } } }) : null;
  check('设置页可渲染', !!settingsTree && settingsTree.$$typeof === 'element', settingsTree ? String(settingsTree.type?.name || settingsTree.type) : '');
} catch (e) {
  check('设置页可渲染', false, e.message);
}
const st = collectText(settingsTree).join(' | ');
check('设置页含插件名称', st.includes('教师模式'), st.slice(0, 50));
check('设置页含开关文案', st.includes('新会话默认进入教学'));
check('设置页含用法说明', st.includes('/teaching on'));
check('设置页自定义 label', typeof regSettings.label === 'function', typeof regSettings.label === 'function' ? String(regSettings.label()) : '');

console.log('\n' + '─'.repeat(40));
console.log(`结果：${pass}/${pass + fail} 通过${fail ? `，${fail} 失败` : ''}`);
process.exit(fail ? 1 : 0);
