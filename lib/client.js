/**
 * dsh-teaching-mode —— 客户端（Web UI）半边
 *
 * 作用：在对话区注册一个「教学」视图页签，把教学流程、用法与铁律摆在手边。
 * 形态：DSH 客户端插件协议 —— window.__ModuleLoader__.load({ id, factory })，React 由宿主提供。
 * 依赖：只用 react + 宿主客户端服务（slot / theme），**不依赖 Remote**，因此在没有 Host 数据通道时也能工作（优雅降级）。
 *
 * 本文件是手写的、可直接加载的客户端模块（用 React.createElement，不用 JSX），因此不需要打包器。
 */
window.__ModuleLoader__.load({
  id: 'dsh-teaching-mode',
  factory: (require) => {
    const React = require('react');
    const h = React.createElement;

    const NS = 'teaching-mode';

    /** 客户端侧的文案（中英），主用中文 */
    const DICT = {
      zh: {
        tab: '教学',
        title: '教师模式',
        subtitle: '让 AI 按老师的方式讲课：一次一个知识点，讲完就测',
        howTitle: '教学流程',
        how: [
          '① 备课：先问课题与教材 → 有材料查目录页码是否齐全 → 没材料先给大纲、你确认后再写正文',
          '② 拆课：小节 → 知识点 → 小知识点，三级粒度',
          '③ 讲：一次只讲一个小知识点，讲完立刻出 1 道卡片例题',
          '④ 收口：整个知识点讲完，再加 2 道卡片例题',
          '⑤ 小结：小节讲完生成复习资料（知识点 + 习题 + 答案）',
          '⑥ 归档：讲义按小节落盘，章末合并总复习',
        ],
        ruleTitle: '铁律',
        rules: [
          '讲透：每个符号、每条规则都要说明含义与原因，不能只给名称和样式',
          '自检：标题写的条数必须与内容条数一致；归纳表格注明「这是归纳，不是教材原文」',
          '不抢跑：以课堂进度为准，前置知识只补最小量，欠账记下来撞到再补',
          '作业题只给答案与解析，不配检验题',
        ],
        useTitle: '怎么用',
        usage: [
          '/teaching on — 开启教师模式（当前会话）',
          '/teaching off — 关闭，恢复普通对话',
          '/teaching status — 查看课题、进度、欠账',
          '/teaching setup <课题> | <教材> — 设置课题与教材',
          '/teaching progress <进度> — 更新进度',
          '/teaching debt <内容> — 记一条欠账',
        ],
        note: '默认不打扰：插件只注入极轻的识别提示，你说「开启教师模式」或带着课程内容提问时才开场。开启后按上面流程授课；关闭后完全恢复原样。',
        switchTitle: '新会话默认进入教学',
        switchHint: '不勾选（默认）：只注入一句识别提示，由你或模型判断何时开场，日常对话不受影响。勾选：你今后每个新会话都会直接进入教学模式、注入完整规程——包括写代码、查资料这类非学习对话，请确认你要的是这个。随时敲 /teaching status 看当前状态。',
        onboardTitle: '教师模式已装好',
        onboardBody: '它默认是关着的，日常对话完全不受影响。想上课：说「开启教师模式」，或者直接带着课程内容来问。',
        onboardHint: '/teaching status 看当前开没开、学到哪；说「下课」或敲 /teaching off 收工。之前上过的课会自动接上，不用重新开课。',
        onboardOk: '知道了',
      },
      en: {
        tab: 'Teaching',
        title: 'Teaching mode',
        subtitle: 'Make the model teach like a teacher: one mini-topic at a time, quiz right after',
        howTitle: 'Teaching loop',
        how: [
          '1 Prep: ask for subject and material first; check headings/pages if material exists; if not, outline first — write only after approval',
          '2 Split: section → topic → mini-topic (three levels)',
          '3 Teach: one mini-topic at a time, then 1 card question immediately',
          '4 Wrap-up: after the whole topic, 2 more card questions',
          '5 Review sheet: when a section ends, generate concepts + exercises + answers',
          '6 Archive: keep notes per section on disk; merge into chapter review',
        ],
        ruleTitle: 'Hard rules',
        rules: [
          'Explain why, not just what: every symbol and rule gets meaning and reason',
          'Heading counts must match content counts; label summary tables as summaries',
          'Do not run ahead of the class; fill only the minimum prerequisites, record gaps',
          'Homework: answers and walkthroughs only, no follow-up quizzes',
        ],
        useTitle: 'Commands',
        usage: [
          '/teaching on — enable for this session',
          '/teaching off — disable',
          '/teaching status — show subject, progress, gaps',
          '/teaching setup <subject> | <material>',
          '/teaching progress <text>',
          '/teaching debt <text> — record a gap',
        ],
        note: 'Quiet by default: the plugin only injects a light intent hint; teaching starts when you say "开启教师模式" or bring course material.',
        switchTitle: 'Start new sessions in teaching mode',
        switchHint: 'Unchecked (default): only a short intent hint is injected — non-study chats stay untouched. Checked: every new session starts in teaching mode with the full protocol, including coding or research chats — make sure that is what you want. Use /teaching status anytime to see the current state.',
        onboardTitle: 'Teaching mode is installed',
        onboardBody: 'It is off by default, so ordinary chats are untouched. To start a lesson, say "开启教师模式" (or bring course material and ask directly).',
        onboardHint: '/teaching status shows whether it is on and how far you got; say "下课" or run /teaching off to stop. Courses you studied before reconnect automatically.',
        onboardOk: 'Got it',
      },
    };

    /** 极简样式（内联，避免依赖主题 token 细节） */
    const styles = {
      wrap: { padding: '16px 18px', fontSize: '13px', lineHeight: '1.75', maxWidth: '760px' },
      h1: { fontSize: '16px', fontWeight: '600', margin: '0 0 4px' },
      sub: { opacity: 0.65, margin: '0 0 16px' },
      h2: { fontSize: '13px', fontWeight: '600', margin: '18px 0 8px' },
      ol: { margin: '0 0 0 18px', padding: 0 },
      ul: { margin: '0 0 0 18px', padding: 0 },
      li: { margin: '2px 0' },
      code: {
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
        fontSize: '12px',
        background: 'rgba(127,127,127,0.12)',
        border: '1px solid rgba(127,127,127,0.22)',
        borderRadius: '4px',
        padding: '6px 8px',
        whiteSpace: 'pre-wrap',
        wordBreak: 'break-all',
      },
      note: {
        marginTop: '16px',
        padding: '8px 10px',
        borderLeft: '3px solid rgba(127,127,127,0.45)',
        background: 'rgba(127,127,127,0.08)',
        borderRadius: '0 4px 4px 0',
      },
    };

    /** 教学面板组件 */
    function TeachingPanel(props) {
      const svc = props && props.services ? props.services : {};
      const t = (key) => {
        const lang = svc.locale && typeof svc.locale.getLocale === 'function'
          ? (svc.locale.getLocale() || {}).id || 'zh'
          : 'zh';
        const dict = DICT[String(lang).startsWith('zh') ? 'zh' : 'en'] || DICT.en;
        return dict[key];
      };
      const lines = (arr) => h('ul', { style: styles.ul }, arr.map((s, i) => h('li', { key: i, style: styles.li }, s)));
      return h('div', { style: styles.wrap },
        h('div', { style: styles.h1 }, t('title')),
        h('div', { style: styles.sub }, t('subtitle')),
        h('div', { style: styles.h2 }, t('howTitle')),
        lines(t('how')),
        h('div', { style: styles.h2 }, t('ruleTitle')),
        lines(t('rules')),
        h('div', { style: styles.h2 }, t('useTitle')),
        h('div', { style: styles.code }, (t('usage') || []).join('\n')),
        h('div', { style: styles.note }, t('note')),
      );
    }

    // ── 设置页：简介 + 开关 + 用法 ──────────────────────────────
    const PREF_KEY = 'dsh-teaching-mode.pref';

    function readPref() {
      try {
        if (typeof localStorage === 'undefined') return { defaultOn: false };
        const raw = localStorage.getItem(PREF_KEY);
        if (!raw) return { defaultOn: false };
        const parsed = JSON.parse(raw);
        return { defaultOn: parsed && parsed.defaultOn === true };
      } catch { return { defaultOn: false }; }
    }
    function writePref(next) {
      try {
        if (typeof localStorage === 'undefined') return;
        localStorage.setItem(PREF_KEY, JSON.stringify(next));
      } catch { /* 忽略：偏好只是本机便利设置 */ }
    }

    const prefStyles = {
      card: { margin: '0 0 14px', padding: '12px 14px', border: '1px solid rgba(127,127,127,0.22)', borderRadius: '8px' },
      row: { display: 'flex', alignItems: 'center', gap: '10px', margin: '0 0 10px' },
      label: { fontWeight: '600' },
      hint: { opacity: 0.6, fontSize: '12px', margin: '4px 0 0' },
      kv: { margin: '2px 0' },
    };

    /**
     * 新手引导条（v0.9.5）：装在输入框上方，装好第一次就告诉用户"这东西已经在了、怎么用"。
     * 为什么是客户端：Host 侧注入只进模型上下文，用户界面上一个字都看不到；
     * 客户端拿不到 Host 状态（没有 Remote 通道），所以这里只讲静态用法，用 localStorage 记住"已看过"。
     */
    const ONBOARD_KEY = 'teaching-mode:onboarded-v1';
    const onboardStyles = {
      card: {
        margin: '0 0 10px', padding: '10px 12px', borderRadius: '10px',
        border: '1px solid rgba(99,102,241,0.35)', background: 'rgba(99,102,241,0.08)',
        color: 'inherit', fontSize: '13px', lineHeight: 1.6,
      },
      head: { display: 'flex', alignItems: 'center', gap: '8px', fontWeight: '600', margin: '0 0 4px' },
      close: { marginLeft: 'auto', cursor: 'pointer', opacity: 0.55, fontSize: '15px', lineHeight: 1 },
      body: { opacity: 0.9 },
      hint: { opacity: 0.65, fontSize: '12px', margin: '4px 0 0' },
      row: { display: 'flex', gap: '8px', margin: '8px 0 0' },
      ok: {
        padding: '3px 10px', borderRadius: '6px', border: '1px solid rgba(99,102,241,0.5)',
        background: 'rgba(99,102,241,0.16)', color: 'inherit', cursor: 'pointer', fontSize: '12px',
      },
    };

    function OnboardingBar(props) {
      const svc = (props && props.services) || {};
      const t = (k) => {
        try {
          const lang = svc.locale && svc.locale.getLocale ? (svc.locale.getLocale() || {}).id : 'zh';
          const dict = DICT[String(lang).startsWith('zh') ? 'zh' : 'en'] || DICT.en;
          return dict[k] || '';
        } catch { return DICT.zh[k] || ''; }
      };
      const [shown, setShown] = React.useState(() => {
        try { return localStorage.getItem(ONBOARD_KEY) !== '1'; } catch { return true; }
      });
      if (!shown) return null;
      const close = () => {
        try { localStorage.setItem(ONBOARD_KEY, '1'); } catch { /* 存不了就只在内存里关掉 */ }
        setShown(false);
      };
      return h('div', { style: onboardStyles.card },
        h('div', { style: onboardStyles.head },
          h('span', null, t('onboardTitle')),
          h('span', { style: onboardStyles.close, onClick: close, title: t('onboardOk') }, '×')),
        h('div', { style: onboardStyles.body }, t('onboardBody')),
        h('div', { style: onboardStyles.hint }, t('onboardHint')),
        h('div', { style: onboardStyles.row },
          h('button', { type: 'button', style: onboardStyles.ok, onClick: close }, t('onboardOk'))),
      );
    }

    function SettingsPage(props) {
      const svc = (props && props.services) || {};
      const [defaultOn, setDefaultOn] = React.useState(readPref().defaultOn);
      React.useEffect(() => { writePref({ defaultOn }); }, [defaultOn]);
      const t = (k) => {
        const lang = svc.locale && svc.locale.getLocale ? (svc.locale.getLocale() || {}).id : 'zh';
        const dict = DICT[String(lang).startsWith('zh') ? 'zh' : 'en'] || DICT.en;
        return dict[k];
      };
      const lines = (arr) => h('ul', { style: styles.ul }, arr.map((s, i) => h('li', { key: i, style: styles.li }, s)));

      return h('div', { style: styles.wrap },
        h('div', { style: prefStyles.card },
          h('div', { style: styles.h1 }, t('title')),
          h('div', { style: styles.sub }, t('subtitle')),
          h('div', { style: styles.note }, t('note')),
        ),

        h('div', { style: prefStyles.card },
          h('div', { style: prefStyles.row },
            h('input', {
              type: 'checkbox',
              checked: defaultOn,
              onChange: (e) => setDefaultOn(!!(e && e.target && e.target.checked)),
            }),
            h('span', { style: prefStyles.label }, t('switchTitle')),
          ),
          h('div', { style: prefStyles.hint }, t('switchHint')),
        ),

        h('div', { style: prefStyles.card },
          h('div', { style: styles.h2 }, t('howTitle')),
          lines(t('how')),
        ),

        h('div', { style: prefStyles.card },
          h('div', { style: styles.h2 }, t('ruleTitle')),
          lines(t('rules')),
        ),

        h('div', { style: prefStyles.card },
          h('div', { style: styles.h2 }, t('useTitle')),
          h('div', { style: styles.code }, (t('usage') || []).join('\n')),
        ),
      );
    }

    const name = 'dsh-teaching-mode';
    // 客户端只用这些服务；宿主没提供某个时会走降级路径而不是崩掉
    const inject = ['slots'];

    function apply(ctx) {
      const log = (m) => { try { ctx.logger?.info?.('[teaching-mode/client] ' + m); } catch { /* ignore */ } };
      const services = {
        locale: ctx.get ? ctx.get('locale') : undefined,
        theme: ctx.get ? ctx.get('theme') : undefined,
      };

      if (!ctx.slots || typeof ctx.slots.register !== 'function') {
        log('slots 服务不可用，教学面板未挂载');
        return;
      }

      // 统一注册助手：把返回值收成可撤销的 effect
      const add = (def, what) => {
        try {
          const off = ctx.slots.register(def);
          if (typeof off === 'function' && typeof ctx.effect === 'function') ctx.effect(() => off, 'teaching-mode:' + what);
          log(what + ' 已注册');
        } catch (e) {
          log(what + ' 注册失败：' + (e && e.message));
        }
      };
      const labelOf = () => {
        try {
          const lang = services.locale && services.locale.getLocale ? (services.locale.getLocale() || {}).id : 'zh';
          return String(lang).startsWith('zh') ? '教学' : 'Teaching';
        } catch { return '教学'; }
      };

      // ① 对话区页签：把教学流程摆在手边
      add({
        name: 'conversation.view',
        id: 'teaching-mode',
        order: 40,
        label: labelOf,
        component: (props) => h(TeachingPanel, { ...props, services }),
      }, 'conversation.view');

      // ② 设置页：简介 + 开关 + 用法（与其它插件并列出现在设置里）
      add({
        name: 'settings.section',
        id: 'teaching-mode',
        order: 60,
        label: labelOf,
        component: (props) => h(SettingsPage, { ...props, services }),
      }, 'settings.section');

      // ③ 新手引导条：输入框上方一次性提示，解决"装好没反应"
      add({
        name: 'conversation.input.dock',
        id: 'teaching-mode-onboarding',
        order: 10,
        component: (props) => h(OnboardingBar, { ...props, services }),
      }, 'conversation.input.dock');
    }

    return { name, inject, apply };
  },
});
