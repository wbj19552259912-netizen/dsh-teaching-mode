# dsh-teaching-mode

[![npm version](https://img.shields.io/npm/v/dsh-teaching-mode.svg)](https://www.npmjs.com/package/dsh-teaching-mode)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![tests](https://img.shields.io/badge/tests-239%20passing-brightgreen.svg)](#development)
[![DeepSeek Harness](https://img.shields.io/badge/DeepSeek%20Harness-plugin-4B6BFB.svg)](https://github.com/deepseek-ai/deepseek-harness)

> A switchable **teaching mode** for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness): one mini-topic at a time → quiz right after → topic wrap-up quiz → section review sheet.

- **Off by default** — it never interferes with ordinary conversations.
- Turn it on with `/teaching on`, off with `/teaching off`.
- State is kept **per session**; one session studies one course.

---

## Why

Asking an AI to teach you inside a long chat usually fails in three ways:

1. **It dumps everything at once** — thousands of words in one reply, nothing retained.
2. **It never tests you** — you cannot tell what you actually understood.
3. **Nothing is kept** — the material lives in the chat log and is painful to revisit weeks later.

This plugin turns "explain → quiz → file it away" into a protocol that is injected into every model request, so the model keeps a teacher's rhythm instead of lecturing.

## The teaching loop

```
Section 8.5
 ├─ Topic A
 │   ├─ mini-topic A1 ── explained → 1 card question
 │   ├─ mini-topic A2 ── explained → 1 card question
 │   └─ Topic A wrap-up ── 2 more card questions
 └─ Topic B … same
Section 8.5 done → "8.5 review sheet" (concepts + exercises + answers)
Chapter done    → merged into a chapter-level review
```

**Hard rules**

- One topic at a time; quiz immediately after explaining.
- Never dump a whole topic at once — split it into mini-topics.
- Each mini-topic → 1 card question; each finished topic → 2 more.
- Each finished section → a review sheet, written to disk (not only in chat).
- Explain *why*, not just *what*: every symbol and rule gets its meaning and reason.
- Heading counts must match content counts; label a table as a summary when it is not the textbook's own wording.
- Homework: answers and walkthroughs only, **no** follow-up quizzes.

**Prep gate (v0.9.0)** — before any teaching starts the model must settle four things with you: textbook table of contents / missing pages, past papers, chapter route, exam info. Until then it asks instead of teaching; a lesson that has already started only gets a softer reminder.

**Generating material one chapter at a time** (when no textbook is at hand)

1. Ask for the subject and material first; if material exists, check its table of contents / page completeness.
2. No material → give the **outline** (chapter → section → topic) and wait for approval.
3. Then generate **the first chapter only** — never the whole book; generated text is labelled as generated.
4. Finish chapter 1, then ask whether to generate chapter 2. Never run ahead.

## Install

Published on npm: [`dsh-teaching-mode`](https://www.npmjs.com/package/dsh-teaching-mode)

```sh
npm install dsh-teaching-mode
```

In the desktop app the CLI is **not allowed to manage the `desktop` profile** (the app owns it), so install from inside the app: open a DSH session and have it run `plugin_manager` → `install_bundle` with target `dsh-teaching-mode` — the package name; DSH resolves it from npm.

From a local checkout instead: clone the repo, then use `install_bundle` with target `file:<absolute-path-to-the-cloned-folder>`.

```sh
git clone https://github.com/wbj19552259912-netizen/dsh-teaching-mode.git
```

Restart DSH (or reload the profile) afterwards.

## UI

Two surfaces, both native DSH UI:

| Where | What |
|---|---|
| **Settings → Teaching** | Plugin summary, a "default on for new sessions" switch, the teaching loop, hard rules and command list |
| **Conversation "Teaching" tab** | Sits next to "Chain of thought" / "Request context"; the loop and rules always at hand |

> The settings switch is a **local preference** (browser storage) meaning "start new sessions in teaching mode". Toggling a specific session still uses `/teaching on` / `/teaching off`.

## Notes are written to disk automatically

You do not have to ask. When a section is finished, its notes and review sheet are written to files:

| Content | Filename |
|---|---|
| Section notes | `第X章-<section>-讲义.md` |
| Section review sheet | `第X章-<section>-复习资料.md` (concepts + exercises + answers) |
| Chapter review | `第X章-总复习.md` |
| Mistake book | `错题本.md` |

Filenames follow the student's language on purpose: the course, its folders and its notes are Chinese, so the files stay sortable next to the rest of the course material.

**Where**: `<this session's working directory>/projects/<subject>/03-产出/` — inside that conversation's own folder, not left in the chat log. The path is derived from `Session.header.cwd` plus the subject set with `/teaching setup`; `/teaching status` shows the current notes directory.

## Continuing a course in a new session (v0.9.3)

A course often outlives one conversation. The plugin therefore does not key a course on the session, but on **which course it is**:

- Subject names are normalised first (`高等数学（同济第七版上册）` and `高等数学（同济第七版）` are the same course).
- When the notes directory of a new session does not exist, the plugin reuses the existing `projects/<subject>/03-产出` instead of creating an empty one, and says so.
- Sessions of the same course are merged (progress, sections, debts, mistakes) every time the plugin starts.
- A session with teaching mode still off sees a short hint listing **the courses already in this workspace** (progress, sections taught, open debts) so it can continue instead of starting from scratch.
- `/teaching courses` lists every course with its sessions; `/teaching link <8-hex-prefix>` copies a course's fields into the current session.

## Commands

Progress can be recorded at three granularities: **section** (小节), **topic/section step** (知识点 / 小知识点) and **chapter** (章).

| Command | Effect |
|---|---|
| `/teaching on` / `off` | Enable / disable teaching mode for this session |
| `/teaching status` | Show subject, material, progress, debts |
| `/teaching setup <subject> \| <material>` | Set subject and textbook; re-derives the notes directory |
| `/teaching progress <text>` | Update current progress, e.g. `/teaching progress 第8章 8.5 数据有多长` |
| `/teaching section <name>` | Set the current section (小节) |
| `/teaching next-section <name>` / `/teaching learn-section <name>` | Set / mark the next section |
| `/teaching finish-section <name>` | Mark a section as taught |
| `/teaching debt <text>` / `/teaching debts` | Record a gap to fill later / list debts and mistakes |
| `/teaching resolve <#\|keyword> [\| note]` / `/teaching drop <#\|keyword> [\| reason]` | Close / void a debt |
| `/teaching mistakes [n]` | Mistake totals, by-layer breakdown, latest entries |
| `/teaching review [topic]` | Build a focused-review block from open debts and recent mistakes |
| `/teaching done <text>` / `/teaching gen <chapter>` | Mark something finished / record that a chapter was generated |
| `/teaching learn <chapter>` / `/teaching next <chapter>` | Mark a chapter studied / set the next chapter |
| `/teaching exam <date> \| <types> \| <scope> \| <papers>` | Record exam info, e.g. `2026-12-31 \| MC20+SA30+Calc50 \| Ch1-5 \| 5 past papers` |
| `/teaching index` | Rebuild `课程索引.md` in the notes directory |
| `/teaching finish-chapter <chapter> \| <next> [--force]` | Close a chapter; blocked unless `第X章-总复习.md` exists (`--force` skips) |
| `/teaching courses` | List every course in the store and its sessions |
| `/teaching link <8-hex-prefix>` | Continue another session's course in this session |
| `/teaching repair` | Heal state (stale current/next section, chapter string split) |
| `/teaching prune [-f]` | Remove empty session records (preview unless `-f`) |
| `/teaching reset` | Clear this session's teaching state |

## Model tools (the model calls these itself)

| Tool | Purpose |
|---|---|
| `teaching_toggle` | Turn the mode on/off; only this tool's `on=true` counts as "really enabled" |
| `teaching_setup` | Record subject, material mode (`textbook` / `outline`) and requirements; derives the notes directory |
| `teaching_prepare` | Prep gate: requires subject / material mode / material / requirements before moving to the syllabus stage |
| `teaching_syllabus` | Submit the syllabus: validates levels (≥2) and micro-point count (≥6), writes `教学大纲.md`; after student confirmation produces receipt `TM-xxxx` |
| `teaching_start` | Start teaching with the receipt; before this step content-question cards are blocked |
| `teaching_update` | Record progress, sections, chapters, debts; `finished_section` requires that section's review file (`force` skips) |
| `teaching_exam` | Record exam date, question types, scope, past papers |
| `teaching_mistake` | Record a mistake including *which layer* was wrong; appended to `错题本.md` |
| `teaching_note_path` | Show the notes directory (created automatically if missing) |

**Start flow (v0.10 state machine)**: `teaching_toggle(on)` → `teaching_setup` → `teaching_prepare` → `teaching_syllabus` (student confirms) → `teaching_start(TM-xxxx)`. The injected status header always states the current phase and the next tool to call.

## Config

**Edit it in DSH settings**: Settings → Plugins → Plugin config → `dsh-teaching-mode` (the form is generated from the plugin schema; saving applies immediately).

| Key | Default | Meaning |
|---|---|---|
| `defaultOn` | `false` | **Start new sessions in teaching mode.** A session you explicitly turned `/teaching off` stays off |
| `statePath` | empty | State file path; empty means `$DSH_HOME/teaching-mode/state.json` |
| `rulesText` | empty | Replace the whole teaching protocol (advanced) |
| `extraRules` | empty | Extra requirements appended to the protocol |

Or write the profile's `cordis.patch.yml` directly:

```yaml
- id: dsh-teaching-mode
  config:
    defaultOn: true
```

## Protocol size (why it does not get slower)

After a course has taught 5+ sections the plugin injects a compact rule set (~1.1k characters) instead of the full protocol (~4.4k), and the state header only shows the latest items. A typical turn injects ~1.8k characters instead of ~4.8k. The notes index is rebuilt only when the file list actually changed, so tool calls no longer scan the directory every time.

## State

Default `$DSH_HOME/teaching-mode/state.json`, bucketed by session id (keys are `session-<uuid>`; the display id is the first 8 hex characters after the prefix):

```json
{
  "version": 1,
  "sessions": {
    "session-xxxx": {
      "on": true,
      "subject": "汇编语言",
      "dataDir": "D:\\…\\projects\\汇编语言学习\\03-产出",
      "chapter": "第8章 8.5 数据有多长",
      "learnedSections": ["8.4 寻址方式总表"],
      "debts": [{ "id": 1, "text": "第3章源程序结构", "status": "open" }],
      "prep": "confirmed",
      "updatedAt": "2026-11-03T00:00:00.000Z"
    }
  }
}
```

Change the location with `statePath` or the environment variable `TEACHING_MODE_STATE`.

## Uninstall

```sh
dsh plugin --profile desktop remove dsh-teaching-mode
```

The plugin is pure injection plus a state file, **it leaves no hooks behind**; delete `$DSH_HOME/teaching-mode/` to remove the state as well.

## Development

```sh
node --check lib/index.js     # syntax
node tests/test.mjs           # 154 contract tests (local mock host, no model calls, no cost)
node tests/client-test.mjs    # 25 client tests
node tests/default-on-test.mjs # 16 default-on tests
node tests/rules-check.mjs    # 29 protocol checks
```

MIT
