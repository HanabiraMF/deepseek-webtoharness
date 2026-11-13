// ==UserScript==
// @name         DeepSeek 本地互联
// @namespace    http://tampermonkey.net/
// @version      2.3
// @description  基于工作区文件的本地智能体扩展系统（纯静默结束判定 + toolcall与返回结果双重折叠 + 启动位置可选）
// @author       You
// @match        https://chat.deepseek.com/*
// @grant        unsafeWindow
// @run-at       document-idle
// ==/UserScript==

(function () {
    'use strict';

    const W = (typeof unsafeWindow !== 'undefined' && unsafeWindow) ? unsafeWindow : window;
    W.DS_Agent_Plugins = W.DS_Agent_Plugins || []; // 初始化前端插件注册表
    W.serverPlugins = []; // 服务端（Node.js）插件列表

    const Svg = (inner, size = 14, extra = '') =>
        `<svg width="${size}" height="${size}" viewBox="0 0 16 16" fill="none" class="ds-svg ${extra}">${inner}</svg>`;
    const I = {
        warning:  Svg('<path d="M8 2L14.5 13.5H1.5L8 2z" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/><path d="M8 6.5v3.5" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/><circle cx="8" cy="11.8" r="0.8" fill="currentColor"/>'),
        check:    Svg('<path d="M3 8l3.5 3.5L13 5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>'),
        close:    Svg('<path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>'),
        spinner:  `<svg width="14" height="14" viewBox="0 0 16 16" fill="none" class="ds-svg ds-spin"><circle cx="8" cy="8" r="6" stroke="currentColor" stroke-opacity="0.25" stroke-width="2"/><path d="M8 2a6 6 0 0 1 6 6" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>`,
        lock:     Svg('<rect x="3" y="7" width="10" height="7" rx="1" stroke="currentColor" stroke-width="1.2"/><path d="M5 7V5a3 3 0 0 1 6 0v2" stroke="currentColor" stroke-width="1.2"/>', 12),
        question: Svg('<circle cx="8" cy="8" r="6.5" stroke="currentColor" stroke-width="1.3"/><path d="M6.2 6.2a1.8 1.8 0 1 1 2.8 1.5c-.6.5-1 1-1 1.6v.2" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/><circle cx="8" cy="11.7" r="0.7" fill="currentColor"/>'),
        copy:     Svg('<rect x="5" y="5" width="9" height="9" rx="1" stroke="currentColor" stroke-width="1.3"/><path d="M3 11V3h8" stroke="currentColor" stroke-width="1.3"/>'),
        arrow:    Svg('<path d="M3 8h10M9 4l4 4-4 4" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/>', 12),
        circle:   Svg('<circle cx="8" cy="8" r="5.5" stroke="currentColor" stroke-width="1.5"/>', 12),
        circleSpin: `<svg width="12" height="12" viewBox="0 0 16 16" fill="none" class="ds-svg ds-spin"><circle cx="8" cy="8" r="5.5" stroke="currentColor" stroke-opacity="0.25" stroke-width="1.5"/><path d="M8 2.5a5.5 5.5 0 0 1 5.5 5.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>`,
        chevron:  Svg('<path d="M6 4l4 4-4 4" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>', 12),
    };

    let isModeOn = false, step = 0;
    let isProcessing = false, isCooldown = false, isCompressing = false;
    let awaitingUser = false; // 弹窗等待用户点击期间：不限时、不强制复位
    let toolcallCounter = 0;   // 连续执行的 toolcall 累计数，达标后冷却
    let isCoolingDown = false; // 批次冷却中
    let autoThrottle = true;   // 是否开启防封控冷却
    const BATCH_LIMIT = 10;    // 达到该数量后，下批执行前冷却
    const BATCH_COOLDOWN_MS = 15000; // 冷却时长
    const SEND_RETRY_MS = 10000;     // 回传失败自动重试间隔
    let processingStart = 0, cooldownTimer = null;
    let absPath = '', autoMode = false;
    let observer = null, observeTimeout = null, pollInterval = null;
    let currentChatUrl = location.href, lastExecTime = 0;
    let isPaused = false;
    let lastGoal = '';

    const TOKEN_KEY = 'ds_agent_token';
    let agentToken = localStorage.getItem(TOKEN_KEY) || '';
    const WORKSPACES_KEY = 'ds_agent_workspaces';
    const STATE_KEY = 'ds_agent_state';
    function loadRecentWorkspaces() {
        try { return JSON.parse(localStorage.getItem(WORKSPACES_KEY) || '[]') || []; } catch { return []; }
    }
    function addRecentWorkspace(p) {
        if (!p) return;
        let list = loadRecentWorkspaces().filter(x => x !== p);
        list.unshift(p);
        list = list.slice(0, 8);
        try { localStorage.setItem(WORKSPACES_KEY, JSON.stringify(list)); } catch {}
    }
    function saveState() {
        try { localStorage.setItem(STATE_KEY, JSON.stringify({ isModeOn, absPath, lastGoal, autoMode, autoThrottle })); } catch {}
    }
    function loadState() {
        try { return JSON.parse(localStorage.getItem(STATE_KEY) || 'null'); } catch { return null; }
    }

    let pendingResults = null;
    let pendingRetries = 0;
    let pendingLastTry = 0;
    const PENDING_MAX_RETRIES = 3;
    const toolcallStatusMap = new Map(); // sig -> 'running' | 'success' | 'error' | 'queue'
    const PROCESS_TIMEOUT = 10 * 60 * 1000; // 10 分钟兜底；单批工具 + 多个弹窗累计可能远超 30s，不能太短
    const interjectQueue = []; // 用户插话队列，随下一次结果回传一并发送
    const ignoreKeys = new Set(); // 「在当前对话内开始」时已存在的消息 key：其工具调用一律不执行，避免重跑历史

    // ===== 消息状态存储：key = data-virtual-list-item-key =====
    const msgStore = new Map(); // key -> { len, lastChange, done, sigs }
    // 已执行签名按消息 key 持久化：msgStore 回收条目后，滚动回来也不会重复执行
    const executedByKey = new Map(); // key -> Set(sig)
    const MSG_STORE_MAX = 60;
    const DONE_QUIET_MS = 1000;        // 纯静默判定：字数 1 秒内不再增加才判定结束

    const SEL = {
        virtualItem:      ['[data-virtual-list-item-key]'],
        assistantContent: ['.ds-assistant-message-main-content', '[class*="assistant-message-main"]'],
        userMsg:          ['.ds-message:not(:has(.ds-assistant-message-main-content))', '.fbb737a4', '[class*="user-message"]'],
        textarea:         ['textarea[placeholder*="DeepSeek"]', 'textarea'],
        sendBtn:          ['div:has(textarea[placeholder*="DeepSeek"]) .ds-button--primary', 'div[role="button"].ds-button--primary', 'div[role="button"][class*="button--primary"]'],
        toolbar:          ['.bf38813a'],
    };
    const pick = (list, root = document) => {
        for (const s of list) {
            try { const el = root.querySelector(s); if (el) return el; } catch {}
        }
        return null;
    };
    const pickAll = (list, root = document) => {
        for (const s of list) {
            try { const els = root.querySelectorAll(s); if (els.length) return els; } catch {}
        }
        return [];
    };

    const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const hashStr = (s) => { let h = 0; for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0; return h; };
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    const log = (msg) => { try { window.dsLog?.(msg); } catch {} };

    // ===== 消息扫描与结束判定（纯静默字数不变） =====
    function getContentLength(item) {
        const c = pick(SEL.assistantContent, item);
        return c ? (c.textContent || '').length : 0;
    }
    function scanMessages() {
        const now = Date.now();
        const items = pickAll(SEL.virtualItem);
        const liveKeys = new Set();
        for (const item of items) {
            const key = item.getAttribute('data-virtual-list-item-key');
            if (!key) continue;
            liveKeys.add(key);
            if (!pick(SEL.assistantContent, item)) continue;
            const len = getContentLength(item);
            let st = msgStore.get(key);
            if (!st) {
                let sigsSet = executedByKey.get(key);
                if (!sigsSet) {
                    sigsSet = new Set();
                    executedByKey.set(key, sigsSet);
                    if (executedByKey.size > 200) {
                        const oldest = executedByKey.keys().next().value;
                        executedByKey.delete(oldest);
                    }
                }
                st = { len: -1, lastChange: now, done: false, sigs: sigsSet };
                msgStore.set(key, st);
            }
            if (len !== st.len) { st.len = len; st.lastChange = now; }
            if (!st.done) {
                if (len > 0 && now - st.lastChange >= DONE_QUIET_MS) st.done = true;
            }
        }
        if (msgStore.size > MSG_STORE_MAX) {
            for (const k of Array.from(msgStore.keys())) {
                if (msgStore.size <= 20) break;
                if (!liveKeys.has(k)) msgStore.delete(k);
            }
        }
    }
    function getLatestAssistantItem() {
        const items = pickAll(SEL.virtualItem);
        for (let i = items.length - 1; i >= 0; i--) {
            if (pick(SEL.assistantContent, items[i])) return items[i];
        }
        return null;
    }

    // 「在当前对话内开始」时调用：把当前页面上已有历史消息里的 toolcall 全部标记为已执行，
    // 防止刷新页面（executedByKey 内存丢失）后重跑历史调用并回传。
    function primeHistoryToolcalls() {
        let n = 0;
        try {
            scanMessages();
            const items = pickAll(SEL.virtualItem);
            for (const item of items) {
                if (!pick(SEL.assistantContent, item)) continue;
                const key = item.getAttribute('data-virtual-list-item-key');
                if (!key) continue;
                const parsed = parseToolcalls(item);
                if (!parsed.calls.length) continue;
                let set = executedByKey.get(key);
                if (!set) { set = new Set(); executedByKey.set(key, set); }
                const st = msgStore.get(key);
                for (const c of parsed.calls) {
                    const sig = toolcallSignature(c);
                    set.add(sig);
                    if (st) st.sigs.add(sig);
                    n++;
                }
            }
        } catch (e) { log('预热历史 toolcall 失败: ' + ((e && e.message) || e)); }
        return n;
    }

    const styleEl = document.createElement('style');
    styleEl.textContent = `
        .ds-svg { display: inline-block; vertical-align: middle; flex-shrink: 0; }
        .ds-spin { animation: ds-spin 0.8s linear infinite; }
        @keyframes ds-spin { to { transform: rotate(360deg); } }
        @keyframes ds-pulse { 0% { opacity: 1; } 50% { opacity: 0.4; } 100% { opacity: 1; } }
        @keyframes ds-fadein { to { opacity: 1; } }
        @keyframes ds-slideup { to { transform: translateY(0); } }
        .ds-panel-container { margin: 8px 12px; padding: 12px; background: var(--dsw-alias-bg-layer-2, #2c2c2e); border-radius: 12px; font-size: 13px; color: var(--dsw-alias-label-primary, #f9fafb); display: flex; flex-direction: column; gap: 10px; border: 1px solid rgba(255,255,255,0.08); box-shadow: 0 4px 12px rgba(0,0,0,0.2); }
        .ds-status-dot { width: 8px; height: 8px; border-radius: 50%; background: #81858c; display: inline-block; margin-right: 6px; flex-shrink: 0; }
        .ds-status-dot.active { background: #3964fe; box-shadow: 0 0 8px rgba(57,100,254,0.6); animation: ds-pulse 2s infinite; }
        .ds-status-dot.working { background: #eab308; box-shadow: 0 0 8px #eab308; animation: ds-pulse 1s infinite; }
        .ds-btn { height: 36px; padding: 0 14px; border-radius: 4096px; border: 1px solid transparent; font-weight: 500; cursor: pointer; transition: background-color .15s, border-color .15s, opacity .15s; font-size: 14px; display: inline-flex; align-items: center; justify-content: center; gap: 6px; font-family: inherit; }
        .ds-btn:disabled { opacity: 0.5; cursor: not-allowed; }
        .ds-btn-primary { background: var(--dsw-alias-brand-primary, #3964fe); color: #fff; }
        .ds-btn-primary:hover:not(:disabled) { background: var(--dsw-static-deepseek-450, #5686fe); }
        .ds-btn-secondary { background: transparent; color: var(--dsw-alias-label-tertiary, #81858c); border-color: rgba(255,255,255,0.12); }
        .ds-btn-secondary:hover:not(:disabled) { background: rgba(255,255,255,0.08); color: var(--dsw-alias-label-primary, #f9fafb); }
        .ds-btn-danger { background: transparent; color: var(--dsw-alias-state-error-primary, #f25a5a); border-color: rgba(242,90,90,0.35); }
        .ds-btn-danger:hover:not(:disabled) { background: rgba(242,90,90,0.12); }
        .ds-input { padding: 8px 12px; background: var(--dsw-alias-bg-layer-1, #232324); border: 1px solid rgba(255,255,255,0.1); color: var(--dsw-alias-label-primary, #f9fafb); border-radius: 10px; font-size: 13px; outline: none; width: 100%; box-sizing: border-box; font-family: inherit; transition: border-color .15s; }
        .ds-input:focus { border-color: var(--dsw-alias-brand-primary, #3964fe); }
        .ds-log-area { max-height: 200px; overflow-y: auto; font-size: 11px; color: #81858c; font-family: ui-monospace, monospace; background: rgba(0,0,0,0.25); padding: 6px; border-radius: 8px; line-height: 1.5; white-space: pre-wrap; }
        .ds-log-area > div { margin-bottom: 2px; }
        .ds-log-area .err { color: #f25a5a; }
        .ds-log-area .ok { color: #4ade80; }
        .ds-overlay { position: fixed; inset: 0; background: rgba(0,0,0,0.6); backdrop-filter: blur(4px); z-index: 99999; display: flex; align-items: center; justify-content: center; opacity: 0; animation: ds-fadein 0.2s forwards; }
        .ds-dialog { background: var(--dsw-alias-bg-layer-2, #2c2c2e); color: var(--dsw-alias-label-primary, #f9fafb); border-radius: 12px; padding: 24px; box-shadow: 0 10px 40px rgba(0,0,0,0.5); border: 1px solid rgba(255,255,255,0.1); display: flex; flex-direction: column; gap: 14px; transform: translateY(10px); animation: ds-slideup 0.3s forwards; max-height: 85vh; overflow-y: auto; }
        .ds-compress-btn { display: inline-flex; align-items: center; justify-content: center; height: 34px; padding: 0 14px; border-radius: 4096px; background: var(--dsw-alias-brand-primary, #3964fe); color: #fff; border: none; cursor: pointer; transition: background-color .15s; white-space: nowrap; font-size: 13px; font-weight: 500; gap: 6px; font-family: inherit; }
        .ds-compress-btn:hover:not(:disabled) { background: var(--dsw-static-deepseek-450, #5686fe); }
        .ds-compress-btn:disabled { opacity: 0.5; cursor: not-allowed; }
        /* ===== 通用折叠列表 ===== */
        .ds-fold-list { display: flex; flex-direction: column; gap: 8px; margin: 10px 0; width: 100%; box-sizing: border-box; }
        .ds-user-tool-card { width: 100%; box-sizing: border-box; align-self: stretch; }
        .ds-user-tool-card .ds-fold-item { width: 100%; box-sizing: border-box; }
        .ds-fold-item { display: flex; flex-direction: column; border-radius: 10px; transition: background-color .2s; }
        .ds-fold-row { display: flex; align-items: center; gap: 8px; padding: 9px 12px; background: var(--dsw-alias-bg-layer-2, #2c2c2e); border: 1px solid rgba(255,255,255,0.08); border-radius: 10px; cursor: pointer; font-size: 13px; color: var(--dsw-alias-label-primary, #f9fafb); font-family: ui-monospace, monospace; user-select: none; transition: border-color .18s, background-color .18s; }
        .ds-fold-row:hover { border-color: rgba(57,100,254,0.5); background: var(--dsw-alias-bg-layer-1, #232324); }
        .ds-fold-row .ds-fold-status { display: inline-flex; flex-shrink: 0; }
        .ds-fold-row .ds-fold-label { flex: 1; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
        .ds-fold-row .ds-fold-label b { color: var(--dsw-alias-brand-primary, #3964fe); font-weight: 600; }
        .ds-fold-row .ds-fold-chevron { display: inline-flex; flex-shrink: 0; color: var(--dsw-alias-label-tertiary, #81858c); transition: transform .25s cubic-bezier(.4,0,.2,1); }
        .ds-fold-item.open .ds-fold-row .ds-fold-chevron { transform: rotate(90deg); }
        /* 折叠详情：grid 动画 + 左侧品牌色条 */
        .ds-fold-detail { display: grid; grid-template-rows: 0fr; transition: grid-template-rows .28s cubic-bezier(.4,0,.2,1), margin-top .28s cubic-bezier(.4,0,.2,1), opacity .2s; opacity: 0; margin-top: 0; }
        .ds-fold-item.open .ds-fold-detail { grid-template-rows: 1fr; margin-top: 8px; opacity: 1; }
        .ds-fold-detail-inner { overflow: hidden; }
        .ds-fold-detail-body { padding: 10px 12px 10px 14px; background: #0d0f14; border-left: 3px solid var(--dsw-alias-brand-primary, #3964fe); border-radius: 8px; font-size: 12.5px; line-height: 1.65; color: #9aa4b2; word-break: break-word; font-family: ui-monospace, monospace; overflow: auto; max-height: 520px; }
        .ds-param-list { display: flex; flex-direction: column; gap: 6px; }
        .ds-param-row { display: flex; gap: 10px; align-items: flex-start; }
        .ds-param-key { flex-shrink: 0; min-width: 62px; color: var(--dsw-alias-brand-primary, #3964fe); font-weight: 600; font-size: 12px; }
        .ds-param-val { flex: 1; color: #c8d0da; white-space: pre-wrap; word-break: break-all; font-size: 12.5px; }
        .ds-param-empty { color: #61666b; font-style: italic; }
        .ds-raw-details { margin-top: 10px; border-top: 1px dashed rgba(255,255,255,0.1); padding-top: 8px; }
        .ds-raw-details > summary { cursor: pointer; color: #81858c; font-size: 11px; user-select: none; }
        .ds-raw-details > summary:hover { color: #3964fe; }
        .ds-raw-xml { margin: 6px 0 0; padding: 8px; background: rgba(0,0,0,0.4); border-radius: 6px; white-space: pre-wrap; word-break: break-all; color: #7d8590; font-size: 11px; max-height: 260px; overflow: auto; }
        .ds-custom-render { font-family: inherit; }
        .ds-plugin-toggle { transition: all .15s; }
        .ds-plugin-toggle:hover { opacity: 0.85; }
        #ds-plugin-toolbar-host, #ds-plugin-toggle-host { pointer-events: auto; }
        /* 结果返回样式微调 */
        .ds-result-label { color: #10b981; }
        
        /* 右上角悬浮通知 (Toast) */
        .ds-toast-container { position: fixed; top: 24px; right: 24px; z-index: 100000; display: flex; flex-direction: column; gap: 10px; pointer-events: none; }
        .ds-toast { background: var(--dsw-alias-bg-layer-2, #1e1e1e); border: 1px solid #333; border-radius: 8px; padding: 12px 16px; box-shadow: 0 10px 30px rgba(0,0,0,0.5); display: flex; align-items: center; gap: 12px; color: #fff; font-size: 13px; font-family: inherit; transform: translateX(120%); transition: transform 0.3s cubic-bezier(0.16, 1, 0.3, 1), opacity 0.3s; opacity: 0; pointer-events: auto; max-width: 350px; word-break: break-all; }
        .ds-toast.show { transform: translateX(0); opacity: 1; }
        .ds-toast-icon { flex-shrink: 0; display: flex; }
        .ds-toast.info .ds-toast-icon { color: #3b82f6; }
        .ds-toast.success .ds-toast-icon { color: #4CAF50; }
        .ds-toast.warning .ds-toast-icon { color: #eab308; }
        .ds-toast.error .ds-toast-icon { color: #d32f2f; }
        .ds-toast-message { line-height: 1.4; }
    `;
    document.head.appendChild(styleEl);

    // ===== 右上角悬浮通知 =====
    let toastContainer = null;
    W.dsShowToast = function(type, message, duration = 3000) {
        if (!toastContainer) {
            toastContainer = document.createElement('div');
            toastContainer.className = 'ds-toast-container';
            document.body.appendChild(toastContainer);
        }

        const toast = document.createElement('div');
        toast.className = `ds-toast ${type}`;
        
        let icon = I.check;
        if (type === 'warning') icon = I.warning;
        if (type === 'error') icon = I.close;
        if (type === 'info') icon = I.question;

        toast.innerHTML = `<span class="ds-toast-icon">${icon}</span><span class="ds-toast-message">${esc(message)}</span>`;
        toastContainer.appendChild(toast);

        // 强制回流后显示动画
        void toast.offsetWidth;
        toast.classList.add('show');

        setTimeout(() => {
            toast.classList.remove('show');
            setTimeout(() => toast.remove(), 300);
        }, duration);
    };
    const showToast = W.dsShowToast;

    function getInitPrompt(absPath, taskGoal) {
        return `【系统指令：本地工作区智能体】

你是本地代码智能体，运行在用户的真实电脑上。

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
【最高优先级：工具调用格式】
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

你的每一次工具调用，必须完整地包裹在 \`\`\`toolcall 代码块里。
这是硬性要求，违反会导致调用被系统拒绝。

✅ 正确写法：
\`\`\`toolcall
<toolcall>
  <op>listdir</op>
  <path>.</path>
</toolcall>
\`\`\`

❌ 错误写法（裸 XML，会被直接拒绝）：
<toolcall>
  <op>listdir</op>
</toolcall>

记住：只要你要调用工具，回复里就必须出现 \`\`\`toolcall 这个标记。没有它 = 失败。

【核心规则】
1. 【第一铁律】同上：必须用 \`\`\`toolcall 包裹完整的 <toolcall>。绝对禁止裸 XML。
2. 【绝对真实】任何目录结构、文件内容、命令结果必须通过工具获取，严禁编造或凭记忆作答。看不到就调工具看。
3. 【先读后写】修改文件前，必须先 openfile 读取当前内容，再 edit。禁止盲目覆盖。
4. 【自动备份】writefile / edit / editline / append / replaceall 执行前，系统会自动生成 .bak 备份，可放心操作。
5. 【批量执行】多个互不依赖的操作（读多个文件、跑多条命令），请在同一个回复里输出多个 toolcall 代码块，系统会按顺序执行并一次性返回全部结果。这比一个个来快得多。
6. 【严谨传参】路径一律用相对路径；参数值含特殊字符（引号、&、<、>、换行）时用 <![CDATA[...]]> 包裹；edit 的 old 必须与文件内容完全一致且唯一。
7. 【失败自省】收到 [失败] 时：仔细读原因 → 修正参数或换方法 → 重试。看到无输出先检查退出码，不要假设成功。
8. 【禁止重复】每个 toolcall 只发一次。结果返回后（无论成功失败）都基于结果继续，绝对不要把同一个调用原样再发一次。
9. 【工程经验】复杂或多行的大段替换，优先写一个临时 Node.js 脚本（writefile + exec）按行号/字符串处理，不要用 edit 硬拼超长内容，容易因为特殊字符导致替换失败。Windows 下给 PowerShell 写脚本文件，必须在开头加 UTF-8 BOM（\uFEFF），否则中文乱码会导致语法错误。写入的文件内容若包含字面量 XML 标签，请用字符串拼接生成（如 "<"+"tag"+">"），避免被解析器截断。
10. 【禁区】严禁删除、覆写或破坏 server.js 和 plugins/ 目录（包括其中任何插件文件）。它们承载着本地互联的基础设施，除非用户在当前对话中明确要求删除，否则一律不得触碰。

【工作区信息】
绝对路径：${absPath}
说明：这是用户通过系统原生对话框选定的目录，所有文件工具与 exec 都在此目录下执行，无法访问外部路径。
起始建议：不确定目录结构时，先 listdir "." 看一眼，再决定操作。相对路径都是相对于这个目录。

【当前目标】
${taskGoal}

【输出格式强制要求】
发起任何操作，必须严格遵循以下包裹格式，否则调用会失败！

正确格式：
\`\`\`toolcall
<toolcall>
  <op>工具名</op>
  <参数>值</参数>
</toolcall>
\`\`\`

【错误类型说明】
/fs 系列工具失败时会返回 errorType，常见值：
- 越界：路径超出工作区范围，只能操作工作区内的文件
- 执行失败：文件系统层面的错误（不存在、无权限、被占用等）
- 参数校验：缺少必填参数或格式不对
收到 越界 时不要尝试绕过，应向用户说明；收到 执行失败 时看 error 详情修正路径或操作方式。

【工具字典】
- listdir: <path>目录</path><tree>true</tree> (列出目录；可选 tree=true 递归输出目录树)
- openfile: <path>文件</path><offset>0</offset><limit>8000</limit> (读文件；可选 offset/limit 按字符分页，大文件可分多次读完)
- mkdir: <path>目录</path> (创建空目录)
- edit: <path>文件</path><old><![CDATA[原]]></old><new><![CDATA[新]]></new> (精准替换)
- editline: <path>文件</path><line>行号</line><mode>replace|insert|delete</mode><content><![CDATA[...]]></content> (按行号编辑)
- writefile: <path>文件</path><content><![CDATA[...]]></content> (整文件覆写)
- append: <path>文件</path><content><![CDATA[...]]></content> (末尾追加)
- replaceall: <find><![CDATA[找]]></find><replace><![CDATA[替换为]]></replace><path>目录或文件</path> (跨文件批量替换)
- grep: <pattern>正则</pattern><path>目录</path> (正则搜索)
- glob: <pattern>**/*.js</pattern> (通配符搜文件)
- search: <pattern>关键词</pattern><path>目录</path><regex>false</regex><name>*.js</name><context>2</context><limit>50</limit> (全文检索：返回文件名+行号+上下文，可选正则/文件名过滤/上下文行数/结果上限)
- tree: <path>目录</path><depth>4</depth><filter>.js,.ts</filter> (目录树：可控深度与扩展名过滤，带文件大小)
- batch: <actions><![CDATA[ [{"op":"copy","from":"a","to":"b"},{"op":"del","path":"c"}] ]]></actions> (批量写操作，最多50个，逐条返回成败；子op支持 mkdir/writefile/append/del/move/copy/edit/editline/replaceall)
- attach: <paths>a.png,b.pdf</paths> (把工作区内的文件「拖入」聊天输入框，支持多文件逗号分隔、图片/文档/大文件，上限200MB。常与 send_message 配合)
- send_message: <content><![CDATA[要发送的文字]]></content> (发送输入框当前内容+已拖入的附件；content 可留空只发附件)
- del: <path>目标</path> (删除)
- move: <from>源</from><to>目标</to> (移动/重命名)
- copy: <from>源</from><to>目标</to> (复制)
- stat: <path>目标</path> (查看信息)
- diff: <path1>文件1</path1><path2>文件2</path2> (对比两文件)
- hash: <path>文件</path> (计算 SHA-256)
- restore: <path>文件</path> (从 .bak 备份恢复该文件，用于撤销误改)
- backups: <path>目录</path><limit>200</limit> (列出所有 .bak 备份，按时间倒序，含原文件是否存在、大小、时间。恢复前先查有哪些可恢复)
- audit: <filter>正则</filter><limit>100</limit> (查看 .ds_audit.log 操作审计记录，可按正则筛选，用于排查"谁在什么时候改了什么")
- cleanbaks: <path>目录</path><keepDays>7</keepDays><keepLatest>1</keepLatest> (清理旧备份：按天数或每文件保留最近N个，防备份堆积)
- 【危险路径保护】对 Windows/Program Files/ProgramData/AppData/回收站 等系统敏感区域的写操作会被拒绝。若确需操作（如用户要求整理），在该 toolcall 内加 <force>true</force> 强制允许。所有写操作都会记入工作区 .ds_audit.log
- readb64: <path>文件</path> (读取文件为 data URL，用于图片展示；一般由 image 工具内部调用)
- exec: <command>命令</command><cwd>可选</cwd><timeout>可选毫秒</timeout> (自动执行命令，静默返回 stdout/stderr 和退出码)
- waitfile: <path>文件</path><timeout>毫秒</timeout> (轮询等待文件生成)
- ask: <question>问题</question><options><option>A</option><option>B</option></options> (询问用户)
- preview: <path>路径</path> (预览网页/文档)
- openurl: <url>地址</url> (打开网页)
- fetch: <url>地址</url><method>GET</method><headers><![CDATA[{"Key":"Val"}]]></headers><content><![CDATA[...]]></content><saveTo>path</saveTo> (HTTP请求；可选 saveTo 把响应体保存到工作区文件，适合大响应)
- image: <path>图片</path> (展示图片)
- clipboard: <text>文本</text> (复制到剪贴板)
- sleep: <timeout>1000</timeout> (休眠指定毫秒，最大 5 分钟；用于轮询间隔或等待外部进程)
- gettime: (获取当前时间)
- register_plugin: <plugin_name>工具名</plugin_name><plugin_js><![CDATA[(返回对象的 JS 代码)]]></plugin_js> (注册一个【前端】自定义工具，当前页面内存生效)
- reload_server_plugins: (无参数) (如果你用 writefile 往 plugins/xxx.js 写了 Node.js 插件，调用此工具热加载它)
- kill_process: <pid>进程ID</pid> (强制终止后台运行的程序。如果 exec 超时返回了 PID，且你觉得它卡死了，用它杀掉)

【关于 exec 与长驻命令】
- exec 会在临时 .bat/.sh 文件中执行你的命令，所以引号、&、|、>、%、$ 等特殊字符都会原样保留，可以放心写复杂命令。
- 如果你的命令运行超过 timeout（默认 30 秒，可自定义），exec 会把已捕获的输出连同进程 PID 一起返回，并让进程继续在后台运行。
- 想让命令在后台常驻（如启动 dev server），显式设置一个较短的 timeout（如 3000）即可主动转入后台。
- 需要用后台进程做别的事时记住返回的 PID；任务结束后调用 kill_process 清理，避免遗留进程。
- 输出超过 10MB 会自动截断（保留尾部），返回里会带 truncated: true 标记。

【关于超时与重试】
- fetch 默认 30 秒超时，exec 默认 30 秒（可调），waitfile 用于轮询等待文件出现。
- 前台请求中断（刷新页面等）会自动杀死对应的子进程，不会留下孤儿。

【自举能力：创造并使用自定义工具】
当你发现现有工具无法满足需求时，可以自己编写插件扩展能力。分为两种：

方式 A：前端临时插件（刷新页面失效）
通过 register_plugin 注册，直接在下一轮使用。插件代码必须返回一个包含 execute 函数的对象，例如：
<plugin_js><![CDATA[
({
    name: 'my_tool',
    description: '我的自定义工具',
    execute: async (args) => { return '结果'; }
})
]]></plugin_js>

方式 B：服务端永久插件（Node.js 环境，无跨域限制，可持久化）
如果你需要访问本地文件、数据库、无跨域限制的网络请求，或需要长期存在的工具，用 writefile 把 Node.js 代码写到 plugins/xxx.js，然后调用 reload_server_plugins 热加载，无需重启服务端。
注意：
- 插件文件名建议用英文小写+下划线，如 plugins/my_tool.js
- name 字段就是 AI 后续调用时的工具名，不要和内置工具重名
- 插件抛出的异常会原样返回给 AI，便于调试
- plugins/ 在 .gitignore 里，属于本地私有资产，不会进仓库

服务端插件模板 (plugins/xxx.js)：
module.exports = {
    name: 'my_node_tool',
    description: '一句话说明用途，会出现在系统提示词里',
    execute: async (args) => {
        // 可用 require('fs') / require('child_process') / require('http') 等
        return '返回给 AI 的文本结果';
    }
};

前端插件参考写法：
<plugin_js><![CDATA[
({
    name: 'my_tool',
    description: '我的自定义工具',
    execute: async (args) => {
        // 在这里写逻辑，可以调用 fetch、操作 DOM、使用 window.DS_Agent_Plugins 等
        // args 包含了 xml 标签解析出的所有参数，自定义标签在 args.extraArgs 中
        return '执行结果文本';
    }
})
]]></plugin_js>

【插件还能挂 UI（可选）】在插件对象里加 ui 字段，注册后自动出现在界面上：
<plugin_js><![CDATA[
({
    name: 'my_tool',
    description: '我的自定义工具',
    execute: async (args) => { return '结果'; },
    ui: {
        // 发送按钮旁加按钮（onClick 收到 (按钮DOM, 插件对象)）
        toolbar: [{ label: '我的按钮', title: '悬停提示', onClick: (btn, self) => { alert('clicked'); } }],
        // 深度思考/智能搜索开关旁加开关（onChange 收到 (state, 插件对象)，状态自动持久化）
        toggle: [{ label: '我的开关', defaultOn: false, onChange: (on, self) => { console.log('switch', on); } }],
        // 自定义该工具在折叠框里的参数渲染（返回 HTML 字符串；返回空则用默认参数表）
        renderTool: (call, self) => {
            return '<div style="color:#3964fe">自定义展示：' + (call.path || '') + '</div>';
        }
    }
})
]]></plugin_js>
注意：register_plugin 每次注册/更新同名插件会自动清理旧 UI，不会重复堆叠。

${getPluginsPrompt()}
`;
    }

    function getPluginsPrompt() {
        let prompt = '';
        if (W.DS_Agent_Plugins && W.DS_Agent_Plugins.length > 0) {
            prompt += '【前端拓展工具】\n';
            W.DS_Agent_Plugins.forEach(p => { prompt += `- ${p.name}: ${p.description}\n`; });
        }
        if (W.serverPlugins && W.serverPlugins.length > 0) {
            prompt += '\n【服务端拓展工具 (Node.js)】\n';
            W.serverPlugins.forEach(p => { prompt += `- ${p.name}: ${p.description}\n`; });
        }
        return prompt;
    }

    async function fetchServerPlugins() {
        try {
            const resp = await agentFetch('/plugins/list', {}, 5000);
            if (resp.ok) {
                const data = await resp.json();
                W.serverPlugins = data.plugins || [];
                log(`已加载 ${W.serverPlugins.length} 个服务端插件`);
            }
        } catch (e) {
            log(`获取服务端插件失败: ${e.message}`);
        }
    }


    function showConfirmDialog(title, target, reason, extraHtml = '') {
        return new Promise(resolve => {
            const o = document.createElement('div');
            o.className = 'ds-overlay';
            const reasonHtml = reason ? `<div style="background:rgba(255,183,77,0.1);padding:10px;border-radius:6px;font-size:12px;color:#ffb74d;border-left:3px solid #ffb74d;display:flex;align-items:flex-start;gap:6px;"><span style="color:#ffb74d;display:flex;margin-top:1px;">${I.warning}</span><span>${esc(reason)}</span></div>` : '';
            o.innerHTML = `
                <div class="ds-dialog" style="width:${extraHtml ? '720px' : '440px'};">
                    <h3 style="margin:0;font-size:15px;display:flex;align-items:center;gap:8px;color:#ffb74d;">${I.warning}<span>${esc(title)}</span></h3>
                    <div style="font-size:13px;">目标：<strong style="color:#3964fe;word-break:break-all;">${esc(target)}</strong></div>
                    ${reasonHtml}${extraHtml}
                    <div style="display:flex;justify-content:flex-end;gap:10px;margin-top:4px;">
                        <button class="ds-btn ds-btn-secondary" id="act-cancel">拒绝</button>
                        <button class="ds-btn ds-btn-danger" id="act-done">确认</button>
                    </div>
                </div>`;
            document.body.appendChild(o);
            awaitingUser = true;
            o.querySelector('#act-cancel').onclick = () => { awaitingUser = false; o.remove(); resolve(false); };
            o.querySelector('#act-done').onclick = () => { awaitingUser = false; o.remove(); resolve(true); };
        });
    }

    function showAskDialog(question, options, reason) {
        return new Promise(resolve => {
            const o = document.createElement('div');
            o.className = 'ds-overlay';
            const optsHtml = options.map((op, i) =>
                `<button class="ask-opt ds-btn ds-btn-secondary" data-idx="${i}" style="text-align:left;justify-content:flex-start;padding:10px 14px;">${esc(op)}</button>`
            ).join('');
            const reasonHtml = reason ? `<div style="background:rgba(255,183,77,0.1);padding:10px;border-radius:6px;font-size:12px;color:#ffb74d;border-left:3px solid #ffb74d;display:flex;align-items:flex-start;gap:6px;"><span style="color:#ffb74d;display:flex;margin-top:1px;">${I.warning}</span><span>${esc(reason)}</span></div>` : '';
            o.innerHTML = `
                <div class="ds-dialog" style="width:520px;">
                    <h3 style="margin:0;font-size:15px;display:flex;align-items:center;gap:8px;color:#3964fe;">${I.question}<span>AI 需要你做出选择</span></h3>
                    <div style="font-size:13px;">${esc(question)}</div>
                    ${reasonHtml}
                    <div style="display:flex;flex-direction:column;gap:8px;">${optsHtml}</div>
                    <div style="display:flex;gap:8px;">
                        <input id="ask-custom" class="ds-input" placeholder="或输入自定义回复..." style="flex:1;" />
                        <button class="ds-btn ds-btn-primary" id="ask-send">发送</button>
                    </div>
                    <button class="ds-btn ds-btn-secondary" id="ask-cancel" style="align-self:flex-end;">取消</button>
                </div>`;
            document.body.appendChild(o);
            awaitingUser = true;
            o.querySelectorAll('.ask-opt').forEach(btn => {
                btn.onclick = () => {
                    const idx = parseInt(btn.dataset.idx, 10);
                    awaitingUser = false; o.remove(); resolve({ cancel: false, choice: options[idx], index: idx });
                };
            });
            const submit = () => {
                const v = o.querySelector('#ask-custom').value.trim();
                if (v) { awaitingUser = false; o.remove(); resolve({ cancel: false, choice: v, index: -1 }); }
            };
            o.querySelector('#ask-send').onclick = submit;
            o.querySelector('#ask-custom').onkeydown = (e) => { if (e.key === 'Enter') submit(); };
            o.querySelector('#ask-cancel').onclick = () => { awaitingUser = false; o.remove(); resolve({ cancel: true }); };
        });
    }

    async function sendMessage(text, timeoutMs = 15000) {
        const start = Date.now();
        // 记录发送前用户的焦点（通常是插话输入框），发送完成后还原，避免被 DeepSeek 输入框/按钮抢走焦点导致插话框失焦
        const prevActive = (typeof document !== 'undefined') ? document.activeElement : null;
        const prevSelStart = (prevActive && typeof prevActive.selectionStart === 'number') ? prevActive.selectionStart : null;
        const prevSelEnd = (prevActive && typeof prevActive.selectionEnd === 'number') ? prevActive.selectionEnd : null;
        let focusRestored = false;
        const restoreFocus = () => {
            if (focusRestored) return;
            focusRestored = true;
            try {
                if (!prevActive || prevActive === document.body || !document.contains(prevActive)) return;
                if (prevActive === document.activeElement) return;
                prevActive.focus({ preventScroll: true });
                if (prevSelStart != null && typeof prevActive.setSelectionRange === 'function') {
                    prevActive.setSelectionRange(prevSelStart, prevSelEnd);
                }
            } catch (e) {}
        };
        const restoreFocusSoon = () => {
            // 点击发送后浏览器可能异步转移焦点，用两段延时兜底还原
            try { requestAnimationFrame(restoreFocus); } catch (e) { setTimeout(restoreFocus, 0); }
            setTimeout(restoreFocus, 120);
            setTimeout(restoreFocus, 400);
        };
        let ta = null;
        while (Date.now() - start < timeoutMs) {
            ta = pick(SEL.textarea);
            if (ta) break;
            await sleep(100);
        }
        if (!ta) return { ok: false, reason: '找不到输入框（页面可能未就绪）' };

        const Proto = W.HTMLTextAreaElement ? W.HTMLTextAreaElement.prototype : HTMLTextAreaElement.prototype;
        const setter = Object.getOwnPropertyDescriptor(Proto, 'value')?.set;
        if (setter) setter.call(ta, text); else ta.value = text;
        ta.dispatchEvent(new Event('input', { bubbles: true }));

        while (Date.now() - start < timeoutMs) {
            const btn = pick(SEL.sendBtn);
            const disabled = !btn || btn.className.includes('disabled') || btn.getAttribute('aria-disabled') === 'true';
            if (!disabled) {
                btn.click();
                restoreFocusSoon();
                return { ok: true };
            }
            await sleep(100);
        }
        restoreFocusSoon();
        return { ok: false, reason: '发送按钮持续不可用（AI 可能仍在生成）' };
    }

    // ===== toolcall 折叠 =====
    function summarizeCall(rawCall) {
        const path = extractTag(rawCall, 'path');
        const command = extractTag(rawCall, 'command');
        const pattern = extractTag(rawCall, 'pattern');
        const url = extractTag(rawCall, 'url');
        const from = extractTag(rawCall, 'from');
        const to = extractTag(rawCall, 'to');
        const question = extractTag(rawCall, 'question');
        const line = extractTag(rawCall, 'line');
        const parts = [];
        if (path) parts.push(path);
        if (command) parts.push(command);
        if (pattern) parts.push(pattern);
        if (url) parts.push(url);
        if (from && to) parts.push(`${from} → ${to}`);
        if (question) parts.push(question);
        if (line) parts.push(`第${line}行`);
        let s = parts.join(' · ');
        if (s.length > 80) s = s.slice(0, 80) + '…';
        return s || '(无参数)';
    }

    function foldToolcalls(root) {
        // 只在正文容器内折叠，避免把思考区里的 toolcall 也折成卡片（思考区与正文是兄弟节点）
        const scopes = [];
        try {
            const mains = root.querySelectorAll('.ds-assistant-message-main-content');
            if (mains.length) mains.forEach(m => scopes.push(m));
            else scopes.push(root);
        } catch { scopes.push(root); }
        const pres = [];
        scopes.forEach(sc => sc.querySelectorAll('pre').forEach(p => pres.push(p)));
        pres.forEach(pre => {
            const text = pre.textContent || '';
            if (!text.includes('<toolcall>')) return;
            // 只折叠真正的代码块（有 md-code-block 父级），裸 XML 留给 parseToolcalls 拦截
            if (!pre.closest('.md-code-block')) return;
            const sig = String(text.length) + '_' + hashStr(text);
            if (pre.getAttribute('data-ds-folded') === sig) return;
            const matches = matchToolcalls(text);
            if (!matches.length) return;

            const block = pre.closest('.md-code-block') || pre;
            const prev = block.previousElementSibling;
            if (prev && prev.classList.contains('ds-fold-list')) prev.remove();

            pre.setAttribute('data-ds-folded', sig);

            const container = document.createElement('div');
            container.className = 'ds-fold-list';
            matches.forEach(rawCall => {
                const op = extractTag(rawCall, 'op') || '?';
                const summary = summarizeCall(rawCall);

                const item = document.createElement('div');
                item.className = 'ds-fold-item';

                const parsedCall = extractCallFromRaw(rawCall);
                const sig = parsedCall ? toolcallSignature(parsedCall) : '';
                item.setAttribute('data-call-sig', sig);

                const status = toolcallStatusMap.get(sig) || 'queue';
                let initialIcon = I.circle, initialColor = '#888';
                if (status === 'running') { initialIcon = I.circleSpin; initialColor = '#eab308'; }
                else if (status === 'success') { initialIcon = I.check; initialColor = '#4CAF50'; }
                else if (status === 'error') { initialIcon = I.close; initialColor = '#d32f2f'; }

                const row = document.createElement('div');
                row.className = 'ds-fold-row';
                row.innerHTML = `<span class="ds-fold-status" style="color:${initialColor}" data-state="${status}">${initialIcon}</span><span class="ds-fold-label"><b>${esc(op)}</b> · ${esc(summary)}</span><span class="ds-fold-chevron">${I.chevron}</span>`;

                const detail = document.createElement('div');
                detail.className = 'ds-fold-detail';
                detail.innerHTML = `<div class="ds-fold-detail-inner"><div class="ds-fold-detail-body">${buildDetailBody(parsedCall || { op }, rawCall)}</div></div>`;
                const rawPre = detail.querySelector('.ds-raw-xml');
                if (rawPre) rawPre.textContent = rawCall;

                row.addEventListener('click', () => {
                    item.classList.toggle('open');
                });

                item.appendChild(row);
                item.appendChild(detail);
                container.appendChild(item);
            });

            block.parentNode.insertBefore(container, block);
            block.style.display = 'none';
        });
    }

    // ===== 工具参数可视化 + 插件自定义渲染 =====
    // 插件可注册：W.DS_ToolRenderers['edit'] = (call) => '<div>自定义HTML</div>'  (返回 null 则用默认)
    W.DS_ToolRenderers = W.DS_ToolRenderers || {};
    const PARAM_KEYS = ['path','from','to','pattern','command','url','method','question','line','mode','timeout','find','replace','old','new','content','headers','text','actions','plugin_name','plugin_js'];
    const PARAM_LABELS = { path:'路径', from:'源', to:'目标', pattern:'匹配', command:'命令', url:'URL', method:'方法', question:'问题', line:'行号', mode:'模式', timeout:'超时', find:'查找', replace:'替换', old:'原内容', new:'新内容', content:'内容', headers:'请求头', text:'文本', actions:'批量操作', plugin_name:'插件名', plugin_js:'插件代码' };
    function clipVal(s, n) {
        s = String(s == null ? '' : s);
        const oneLine = s.length > 300 ? s.slice(0, 300) + ' …(' + s.length + '字)' : s;
        return oneLine;
    }
    function renderParamList(call) {
        const rows = [];
        for (const k of PARAM_KEYS) {
            if (call[k] === undefined || call[k] === null || call[k] === '') continue;
            rows.push({ k, label: PARAM_LABELS[k] || k, v: clipVal(call[k]) });
        }
        // extraArgs（自定义标签）
        const ex = call.extraArgs || {};
        for (const k of Object.keys(ex)) {
            if (ex[k] === undefined || ex[k] === null || ex[k] === '') continue;
            rows.push({ k: 'ex:' + k, label: k, v: clipVal(ex[k]) });
        }
        if (!rows.length) return '';
        let html = '<div class="ds-param-list">';
        for (const r of rows) {
            html += '<div class="ds-param-row"><span class="ds-param-key">' + esc(r.label) + '</span><span class="ds-param-val">' + esc(r.v) + '</span></div>';
        }
        html += '</div>';
        return html;
    }
    function buildDetailBody(call, rawXml) {
        // 插件自定义渲染优先
        try {
            const opName = String(call.op || '').toLowerCase();
            const renderer = W.DS_ToolRenderers[opName];
            if (typeof renderer === 'function') {
                const custom = renderer(call);
                if (custom != null && custom !== '') {
                    return '<div class="ds-custom-render">' + custom + '</div>';
                }
            }
        } catch (e) { log('插件渲染异常: ' + e.message); }
        const params = renderParamList(call);
        let html = params;
        if (rawXml) {
            html += '<details class="ds-raw-details"><summary>原始 XML</summary><pre class="ds-raw-xml"></pre></details>';
        }
        return html || '<div class="ds-param-empty">（无参数）</div>';
    }

    function foldAllToolcalls() {
        pickAll(SEL.virtualItem).forEach(item => {
            if (!pick(SEL.assistantContent, item)) return;
            try { foldToolcalls(item); } catch {}
        });
    }

    // ===== 工具返回结果折叠（新样式） =====
    function hideToolResultMessages() {
        pickAll(SEL.userMsg).forEach(el => {
            if (el.getAttribute('data-ds-hidden') === 'true') return;
            const text = el.innerText || '';
            if (text.trim().startsWith('【系统执行结果】\n')) {
                el.setAttribute('data-ds-hidden', 'true');
                const parent = el.parentElement;
                if (!parent || parent.querySelector('.ds-user-tool-card')) return;

                el.style.display = 'none';
                const container = document.createElement('div');
                container.className = 'ds-user-tool-card ds-fold-list';

                // 解析每一条 [成功] / [失败] / [取消]
                const blocks = text.split('\n\n');
                let addedCount = 0;
                for (const block of blocks) {
                    const match = block.match(/^\[(成功|失败|取消)\]\s+(\w+)(?:\s+\(([^)]+)\))?:\n([\s\S]*)$/);
                    if (!match) continue;

                    const status = match[1];
                    const opName = match[2];
                    const pathInfo = match[3] || '';
                    const content = match[4].trim();

                    const item = document.createElement('div');
                    item.className = 'ds-fold-item';

                    const row = document.createElement('div');
                    row.className = 'ds-fold-row';
                    let icon = I.check, color = '#4CAF50';
                    if (status === '失败') { icon = I.close; color = '#d32f2f'; }
                    else if (status === '取消') { icon = I.circle; color = '#888'; }

                    row.innerHTML = `<span class="ds-fold-status" style="color:${color}">${icon}</span><span class="ds-fold-label"><b style="color:${color}">[${status}]</b> ${esc(opName)} · ${esc(pathInfo || '无路径')}</span><span class="ds-fold-chevron">${I.chevron}</span>`;

                    const detail = document.createElement('div');
                    detail.className = 'ds-fold-detail';
                    detail.innerHTML = `<div class="ds-fold-detail-inner"><div class="ds-fold-detail-body"></div></div>`;
                    detail.querySelector('.ds-fold-detail-body').textContent = content;

                    row.addEventListener('click', () => {
                        item.classList.toggle('open');
                    });

                    item.appendChild(row);
                    item.appendChild(detail);
                    container.appendChild(item);
                    addedCount++;
                }

                // 如果正则解析失败，退化为单行折叠原始文本
                if (addedCount === 0) {
                    const item = document.createElement('div');
                    item.className = 'ds-fold-item';
                    const row = document.createElement('div');
                    row.className = 'ds-fold-row';
                    row.innerHTML = `<span class="ds-fold-status" style="color:#888">${I.circle}</span><span class="ds-fold-label"><b>工具结果已返回</b></span><span class="ds-fold-chevron">${I.chevron}</span>`;
                    const detail = document.createElement('div');
                    detail.className = 'ds-fold-detail';
                    detail.innerHTML = `<div class="ds-fold-detail-inner"><div class="ds-fold-detail-body"></div></div>`;
                    detail.querySelector('.ds-fold-detail-body').textContent = text;
                    row.addEventListener('click', () => {
                        item.classList.toggle('open');
                    });
                    item.appendChild(row);
                    item.appendChild(detail);
                    container.appendChild(item);
                }

                parent.insertBefore(container, el);
            }
        });
    }

    function toolcallSignature(call) {
        const base = [call.op, call.path, call.from, call.to, call.url, call.pattern, call.command, call.question, call.text, call.method, call.find, call.replace, call.line].join('|');
        return base + '|' + hashStr((call.content || '') + '|' + (call.old || '') + '|' + (call.new || ''));
    }

    function extractTag(xml, tag) {
        const m = xml.match(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}\\s*>`, 'i'));
        if (!m) return '';
        let val = m[1].trim();
        if (val.startsWith('<![CDATA[')) val = val.slice(9);
        if (val.endsWith(']]>')) val = val.slice(0, -3);
        if (['path', 'from', 'to', 'line'].includes(tag)) val = val.replace(/[<>:"|?*\n\r\t]/g, '');
        return val;
    }

    function extractCallFromRaw(tcStr) {
        const op = extractTag(tcStr, 'op');
        if (!op) return null;
        const options = [];
        const om = tcStr.match(/<options>([\s\S]*?)<\/options>/);
        if (om) {
            const re = /<option[^>]*>([\s\S]*?)<\/option>/g;
            let mm;
            while ((mm = re.exec(om[1])) !== null) options.push(mm[1].trim());
        }
        // 提取所有自定义标签存入 extraArgs（排除已知的核心标签）
        const knownTags = new Set(['op', 'path', 'reason', 'content', 'old', 'new', 'pattern', 'command', 'question', 'url', 'from', 'to', 'find', 'replace', 'line', 'mode', 'timeout', 'path1', 'path2', 'method', 'headers', 'text', 'options', 'option', 'plugin_name', 'plugin_js', 'cwd', 'ms', 'pid', 'paths']);
        const extraArgs = {};
        // 剥离最外层 toolcall 包裹（按位置切割，避免外层标签被当成名为 toolcall 的自定义标签、吞掉内部所有参数）
        let innerXml = String(tcStr).replace(/^\s*<[^>]*>/, '');
        innerXml = innerXml.replace(/<[^>]*>\s*$/, '');
        const tagRegex = /<([a-zA-Z0-9_]+)\b[^>]*>([\s\S]*?)<\/\1\s*>/gi;
        let match;
        while ((match = tagRegex.exec(innerXml)) !== null) {
            const tag = match[1].toLowerCase();
            if (!knownTags.has(tag)) {
                let val = match[2].trim();
                if (val.startsWith('<![CDATA[')) val = val.slice(9, -3);
                extraArgs[tag] = val;
            }
        }

        return {
            op, path: extractTag(tcStr, 'path'), reason: extractTag(tcStr, 'reason'),
            content: extractTag(tcStr, 'content'), old: extractTag(tcStr, 'old'),
            new: extractTag(tcStr, 'new'), pattern: extractTag(tcStr, 'pattern'),
            command: extractTag(tcStr, 'command'), question: extractTag(tcStr, 'question'),
            url: extractTag(tcStr, 'url'), from: extractTag(tcStr, 'from'),
            to: extractTag(tcStr, 'to'), find: extractTag(tcStr, 'find'),
            replace: extractTag(tcStr, 'replace'), line: extractTag(tcStr, 'line'),
            mode: extractTag(tcStr, 'mode'), timeout: extractTag(tcStr, 'timeout'),
            path1: extractTag(tcStr, 'path1'), path2: extractTag(tcStr, 'path2'),
            method: (extractTag(tcStr, 'method') || 'GET').toUpperCase(),
            headers: extractTag(tcStr, 'headers'), text: extractTag(tcStr, 'text'), options,
            plugin_name: extractTag(tcStr, 'plugin_name'), plugin_js: extractTag(tcStr, 'plugin_js'),
            cwd: extractTag(tcStr, 'cwd'), ms: extractTag(tcStr, 'ms'), pid: extractTag(tcStr, 'pid'),
            paths: extractTag(tcStr, 'paths'),
            extraArgs
        };
    }


    // CDATA 感知的 toolcall 匹配器
    // 问题：内容里出现字面量 <toolcall> 时，非贪婪正则会在内部的 </toolcall> 处提前截断
    // 方案：遍历时跳过 CDATA 区块，并对外层标签做配对计数
    function matchToolcalls(text) {
        const results = [];
        const CDO = "<![CDATA[";
        const CDC = "]]>";
        let i = 0;
        while (i < text.length) {
            const start = text.indexOf("<toolcall>", i);
            if (start === -1) break;
            let j = start + 10;
            let depth = 1;
            let end = -1;
            while (j < text.length) {
                if (text.startsWith(CDO, j)) {
                    const cdataEnd = text.indexOf(CDC, j + CDO.length);
                    if (cdataEnd === -1) { j += CDO.length; continue; }
                    j = cdataEnd + CDC.length;
                    continue;
                }
                if (text.startsWith("<toolcall>", j)) { depth++; j += 10; continue; }
                if (text.startsWith("</toolcall>", j)) {
                    depth--;
                    if (depth === 0) { end = j + 11; break; }
                    j += 11;
                    continue;
                }
                j++;
            }
            if (end > 0) { results.push(text.slice(start, end)); i = end; }
            else { i = start + 10; }
        }
        return results;
    }
    function parseToolcalls(container) {
        const clone = container.cloneNode(true);
        clone.querySelectorAll('.ds-fold-list').forEach(el => el.remove()); // 移除我们注入的折叠 DOM，防止重复解析已折叠的签名
        clone.querySelectorAll('.ds-think-content').forEach(el => el.remove()); // 兜底：dark 主题用这个类名标记思考区
        // 白名单收敛：只保留正文容器 .ds-assistant-message-main-content，思考区是它的兄弟节点会被自然排除。
        // 关键：思考区类名随主题变化（dark 有 .ds-think-content，light 可能没有），单靠类名删除不可靠，
        //       所以改为“只认正文容器”，避免思考过程里的 toolcall 被误当正文执行。
        try {
            const MAIN_SEL = '.ds-assistant-message-main-content';
            const mains = clone.querySelectorAll(MAIN_SEL);
            if (mains.length) {
                const holder = document.createElement('div');
                mains.forEach(m => holder.appendChild(m.cloneNode(true)));
                clone.innerHTML = '';
                clone.appendChild(holder);
            } else {
                // 老版本 DOM 没有正文容器时的兜底：删除疑似思考区节点
                clone.querySelectorAll('[class*="think"], [class*="reason"], [class*="thought"]').forEach(el => el.remove());
            }
        } catch (e) { log('正文白名单收敛异常: ' + ((e && e.message) || e)); }
        const TC_OPEN = '<'+'toolcall'+'>';
        const rawTexts = [];
        const invalidTexts = [];

        // 1) 代码块中的 toolcall：合法
        clone.querySelectorAll('pre').forEach(pre => {
            const rawText = pre.textContent;
            if (!rawText.includes(TC_OPEN)) return;

            // 已被 foldToolcalls 处理过的 pre（带 data-ds-folded）说明原本就是合法代码块，
            // 直接当合法处理，避免误判为裸 XML
            const alreadyFolded = pre.hasAttribute('data-ds-folded');
            // 检查是不是真正的 Markdown 代码块
            const isCodeBlock = alreadyFolded || !!pre.closest('.md-code-block');
            if (isCodeBlock) {
                rawTexts.push(rawText);
            } else {
                invalidTexts.push(rawText);
            }
        });

        // 2) 扫描散落在正文（非 pre / 非行内 code）的裸 XML
        //    启发式：块内必须同时含 op 开闭标签，避免把正文里讨论格式的文字误判为调用
        try {
            const loose = [];
            const walker = document.createTreeWalker(clone, NodeFilter.SHOW_TEXT, null);
            let tn;
            while ((tn = walker.nextNode())) {
                const val = tn.nodeValue;
                if (!val || val.indexOf(TC_OPEN) === -1) continue;
                const pe = tn.parentElement;
                if (!pe) continue;
                if (pe.closest('pre')) continue;   // 已在第 1 步处理
                if (pe.closest('code')) continue;  // 行内代码视为示例
                loose.push(val);
            }
            if (loose.length) {
                const joined = loose.join('\n');
                const opOpen = '<'+'op'+'>', opClose = '<'+'/op'+'>';
                for (const c of matchToolcalls(joined)) {
                    const low = c.toLowerCase();
                    if (low.indexOf(opOpen) !== -1 && low.indexOf(opClose) !== -1) invalidTexts.push(c);
                }
            }
        } catch (e) { log('裸XML文本扫描异常: ' + ((e && e.message) || e)); }

        const calls = [];
        for (const rawText of rawTexts) {
            const matches = matchToolcalls(rawText);
            for (const tcStr of matches) {
                const c = extractCallFromRaw(tcStr);
                if (c) calls.push(c);
            }
        }
        return { calls, invalidTexts };
    }

    class ToolError extends Error {
        constructor(step, message, hint) {
            super(message);
            this.name = 'ToolError';
            this.dsStep = step;
            this.dsHint = hint;
        }
    }
    const stepErr = (step, e, hint) => {
        const t = new ToolError(step, (e && e.message) || String(e), hint);
        if (e && e.name && e.name !== 'Error') t.name = e.name;
        return t;
    };

    function describeParams(call) {
        const clip = (s, n = 120) => {
            s = String(s ?? '');
            return s.length > n ? s.slice(0, n) + `…(${s.length}字)` : s;
        };
        const parts = [];
        if (call.path) parts.push(`path=${clip(call.path, 100)}`);
        if (call.from) parts.push(`from=${clip(call.from, 100)}`);
        if (call.to) parts.push(`to=${clip(call.to, 100)}`);
        if (call.pattern) parts.push(`pattern=${clip(call.pattern, 100)}`);
        if (call.command) parts.push(`command=${clip(call.command, 200)}`);
        if (call.url) parts.push(`url=${clip(call.url, 200)}`);
        if (call.old) parts.push(`old=${clip(call.old)}`);
        if (call.line) parts.push(`line=${call.line}`);
        if (call.find) parts.push(`find=${clip(call.find)}`);
        return parts.join(', ');
    }

    function formatToolError(op, call, e) {
        const lines = [`[失败] ${op}`];
        if (e.dsStep) lines.push(`失败步骤: ${e.dsStep}`);
        const typeName = (e.name && e.name !== 'Error' && e.name !== 'ToolError') ? `${e.name}: ` : '';
        lines.push(`原因: ${typeName}${e.message}`);
        const params = describeParams(call);
        if (params) lines.push(`参数: ${params}`);
        if (e.dsHint) lines.push(`建议: ${e.dsHint}`);
        return lines.join('\n');
    }

    function displayFor(call) {
        return call.path || call.from || call.pattern || call.command || call.url || call.question || call.line || '...';
    }

    async function agentFetch(path, body, timeoutMs = 30000) {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), timeoutMs);
        try {
            const headers = { 'Content-Type': 'application/json' };
            if (agentToken) headers['X-Agent-Token'] = agentToken;
            const resp = await fetch(`http://127.0.0.1:39999${path}`, {
                method: 'POST', headers, body: JSON.stringify(body), signal: ctrl.signal,
            });
            if (resp.status === 403) throw new Error('本地服务拒绝访问（Origin 不在白名单，或 token 无效/未配置）');
            return resp;
        } catch (e) {
            if (e.name === 'AbortError') throw new Error('本地服务请求超时');
            throw e;
        } finally { clearTimeout(timer); }
    }

    // 所有文件操作统一转发到后端 /fs（后端工作区 = 服务启动目录）
    let currentForce = false; // 当前工具调用是否强制允许危险路径
    const FS_READONLY_OPS = new Set(['listdir','openfile','read','stat','diff','hash','grep','glob','tree','search','readb64']);
    async function fsCall(op, args) {
        const payload = Object.assign({ op, force: currentForce }, args || {});
        const canRetry = FS_READONLY_OPS.has(op);
        const maxTry = canRetry ? 3 : 1;
        let lastErr = '';
        for (let attempt = 0; attempt < maxTry; attempt++) {
            try {
                const resp = await agentFetch('/fs', payload, 60000);
                if (!resp.ok) {
                    lastErr = `HTTP ${resp.status}`;
                    if (canRetry && (resp.status >= 500 || resp.status === 429) && attempt < maxTry - 1) {
                        await sleep(500 * (attempt + 1));
                        continue;
                    }
                    return { ok: false, error: lastErr };
                }
                return await resp.json();
            } catch (e) {
                lastErr = e.message || String(e);
                if (canRetry && attempt < maxTry - 1) {
                    log(`fsCall ${op} 失败（${lastErr}），重试 ${attempt + 1}/${maxTry - 1}...`);
                    await sleep(500 * (attempt + 1));
                    continue;
                }
                return { ok: false, error: lastErr };
            }
        }
        return { ok: false, error: lastErr };
    }

    // ================== 工具实现 ==================
    async function toolListdir(call) {
        const p = call.path || '.';
        const tree = /^(true|1|yes)$/i.test(String(call.extraArgs?.tree || '').trim());
        const r = await fsCall('listdir', { path: p, tree });
        if (!r.ok) throw new ToolError('列出目录', r.error, '请确认目录存在，可先 listdir "." 查看根目录');
        return r.result;
    }

    async function toolOpenfile(call) {
        if (!call.path) throw new ToolError('参数校验', '缺少 path', '请在 <path> 中提供文件路径');
        const offset = call.extraArgs?.offset;
        const limit = call.extraArgs?.limit;
        const r = await fsCall('openfile', { path: call.path, offset, limit });
        if (!r.ok) throw new ToolError('读取文件', r.error, '请先 listdir 确认文件存在');
        return r.result;
    }

    async function toolMkdir(call) {
        if (!call.path) throw new ToolError('参数校验', '缺少 path', '');
        const r = await fsCall('mkdir', { path: call.path });
        if (!r.ok) throw new ToolError('创建目录', r.error, '');
        return r.result;
    }

    async function toolAppend(call, reason) {
        if (!call.path) throw new ToolError('参数校验', '缺少 path', '');
        if (call.content === undefined) throw new ToolError('参数校验', '缺少 content', '');
        if (!autoMode) {
            if (!await showConfirmDialog('追加内容', call.path, reason, `<div style="background:#000;padding:8px;color:#4ade80;max-height:150px;overflow:auto;white-space:pre-wrap;font-family:ui-monospace,monospace;font-size:11px;">${esc(call.content.slice(0, 500))}</div>`))
                throw new ToolError('用户确认', '用户取消了追加', '');
        }
        const r = await fsCall('append', { path: call.path, content: call.content });
        if (!r.ok) throw new ToolError('追加写入', r.error, '');
        return r.result;
    }

    async function toolGrep(call) {
        if (!call.pattern) throw new ToolError('参数校验', '缺少 pattern', '请在 <pattern> 中提供正则');
        const r = await fsCall('grep', { pattern: call.pattern, path: call.path || '.' });
        if (!r.ok) throw new ToolError('搜索', r.error, '检查正则语法是否正确；目录不存在可先 listdir');
        return `grep "${call.pattern}" @ ${call.path || '.'}:\n${r.result}`;
    }

    async function toolGlob(call) {
        if (!call.pattern) throw new ToolError('参数校验', '缺少 pattern', '例如 **/*.js');
        const r = await fsCall('glob', { pattern: call.pattern });
        if (!r.ok) throw new ToolError('文件名匹配', r.error, '');
        return `glob "${call.pattern}":\n${r.result}`;
    }

    function readExtra(call, name) {
        const ex = call.extraArgs || {};
        const v = ex[name] != null ? ex[name] : ex[name.toLowerCase()];
        return v == null ? '' : String(v).trim();
    }

    async function toolSearch(call) {
        const kw = call.pattern || call.keyword;
        if (!kw) throw new ToolError('参数校验', '缺少 pattern（搜索关键词或正则）', '例如 <pattern>useState</pattern>');
        const regex = /^(true|1|yes)$/i.test(readExtra(call, 'regex'));
        const name = readExtra(call, 'name');
        const context = readExtra(call, 'context');
        const limit = readExtra(call, 'limit');
        const r = await fsCall('search', {
            pattern: kw, path: call.path || '.',
            regex, name: name || undefined, context: context || undefined, limit: limit || undefined
        });
        if (!r.ok) throw new ToolError('全文检索', r.error, '检查正则语法；目录不存在可先 tree/listdir');
        return r.result;
    }

    async function toolTree(call) {
        const depth = readExtra(call, 'depth');
        const filter = readExtra(call, 'filter');
        const r = await fsCall('tree', { path: call.path || '.', depth: depth || undefined, filter: filter || undefined });
        if (!r.ok) throw new ToolError('目录树', r.error, '请确认目录存在');
        return r.result;
    }

    async function toolBackups(call) {
        const limit = readExtra(call, 'limit');
        const r = await fsCall('backups', { path: call.path || '.', limit: limit || undefined });
        if (!r.ok) throw new ToolError('列出备份', r.error, '');
        return r.result;
    }

    async function toolAudit(call) {
        const filter = readExtra(call, 'filter');
        const limit = readExtra(call, 'limit');
        const r = await fsCall('audit', { filter: filter || undefined, limit: limit || undefined });
        if (!r.ok) throw new ToolError('查看审计日志', r.error, '检查 filter 正则语法');
        return r.result;
    }

    async function toolCleanbaks(call, reason) {
        const keepDays = readExtra(call, 'keepDays') || readExtra(call, 'keepdays');
        const keepLatest = readExtra(call, 'keepLatest') || readExtra(call, 'keeplatest');
        if (!keepDays && !keepLatest) throw new ToolError('参数校验', '需提供 keepDays 或 keepLatest', '如 <keepDays>7</keepDays> 或 <keepLatest>1</keepLatest>');
        if (!autoMode) {
            if (!await showConfirmDialog('清理旧备份', call.path || '.', reason,
                `<div style="font-size:12px;color:#ffb74d;">${keepDays ? '删除 ' + keepDays + ' 天前的备份' : ''} ${keepLatest ? '每个文件只保留最近 ' + keepLatest + ' 个备份' : ''}</div>`))
                throw new ToolError('用户确认', '用户取消了备份清理', '');
        }
        const r = await fsCall('cleanbaks', { path: call.path || '.', keepDays: keepDays || undefined, keepLatest: keepLatest || undefined });
        if (!r.ok) throw new ToolError('清理备份', r.error, '');
        return r.result;
    }

    async function toolBatch(call, reason) {
        const raw = readExtra(call, 'actions') || call.content;
        if (!raw) throw new ToolError('参数校验', '缺少 actions（JSON 数组）', '格式：[{"op":"copy","from":"a","to":"b"},...]');
        let actions;
        try { actions = JSON.parse(raw); } catch (e) { throw new ToolError('参数校验', 'actions 不是合法 JSON: ' + e.message, '注意必须是 JSON 数组，字符串用双引号'); }
        if (!Array.isArray(actions) || !actions.length) throw new ToolError('参数校验', 'actions 必须是非空数组', '');
        if (actions.length > 50) throw new ToolError('参数校验', '单次最多 50 个操作', '请拆成多次 batch');

        if (!autoMode) {
            const listHtml = actions.map((a, i) =>
                `<div style="font-size:11px;padding:3px 0;border-bottom:1px solid rgba(255,255,255,0.06);"><b style="color:#3964fe">${i + 1}. ${esc(a.op || '?')}</b> ${esc(a.path || (a.from ? a.from + ' → ' + a.to : ''))}</div>`
            ).join('');
            if (!await showConfirmDialog('批量操作', actions.length + ' 个操作', reason,
                `<div style="max-height:220px;overflow:auto;background:#000;padding:8px;border-radius:6px;">${listHtml}</div>`))
                throw new ToolError('用户确认', '用户取消了批量操作', '');
        }

        const r = await fsCall('batch', { actions });
        if (!r.ok) throw new ToolError('批量操作', r.error, '检查各子操作的路径与参数');
        return r.result;
    }

    async function toolWritefile(call, reason) {
        if (!call.path) throw new ToolError('参数校验', '缺少 path', '');
        if (call.content === undefined || call.content === null) throw new ToolError('参数校验', '缺少 content', '请在 <content> 中提供文件内容');
        if (!autoMode) {
            const st = await fsCall('stat', { path: call.path });
            if (st.ok) {
                if (st.result.startsWith('类型: 目录')) throw new ToolError('检查路径', `"${call.path}" 是目录，不能写入`, '请提供文件路径');
                let oldContent = '';
                const rd = await fsCall('read', { path: call.path });
                if (rd.ok) oldContent = rd.result;
                const preview = `<div style="display:flex;gap:8px;margin-top:8px;"><div style="flex:1;background:#000;padding:8px;color:#f87171;max-height:150px;overflow:auto;white-space:pre-wrap;font-family:ui-monospace,monospace;font-size:11px;">旧:\n${esc(oldContent.slice(0, 500))}</div><div style="flex:1;background:#000;padding:8px;color:#4ade80;max-height:150px;overflow:auto;white-space:pre-wrap;font-family:ui-monospace,monospace;font-size:11px;">新:\n${esc(call.content.slice(0, 500))}</div></div>`;
                if (!await showConfirmDialog('覆盖文件', call.path, reason, preview))
                    throw new ToolError('用户确认', '用户取消了写入', '');
            }
        }
        const r = await fsCall('writefile', { path: call.path, content: call.content });
        if (!r.ok) throw new ToolError('写入文件', r.error, '请确认父目录存在（可先 listdir 或 mkdir），路径不能是目录');
        return r.result;
    }

    async function toolEdit(call, reason) {
        const { path, old: oldStr, new: newStr } = call;
        if (!path) throw new ToolError('参数校验', '缺少 path', '');
        if (!oldStr) throw new ToolError('参数校验', '缺少 old（原内容，不能为空）', '');
        if (newStr === undefined) throw new ToolError('参数校验', '缺少 new（新内容，可为空）', '');

        const rd = await fsCall('read', { path });
        if (!rd.ok) throw new ToolError('检查路径', rd.error, '请先 listdir 确认文件存在');
        const original = rd.result;

        const firstIdx = original.indexOf(oldStr);
        if (firstIdx === -1) {
            const oldFirst = oldStr.split('\n')[0].trim().slice(0, 60);
            const near = oldFirst ? original.indexOf(oldFirst) : -1;
            let hint = 'old 与文件内容不完全一致（注意缩进、空白、换行符）';
            if (near !== -1) {
                const line = original.slice(0, near).split('\n').length;
                hint = `首行 "${oldFirst}" 在第 ${line} 行附近找到，但整体不匹配，请检查后续行、缩进或换行`;
            } else {
                hint = '文件里没有这段内容，请先 openfile 读取最新内容再编辑';
            }
            throw new ToolError('匹配 old', 'old 块在文件中未找到', hint);
        }
        const secondIdx = original.indexOf(oldStr, firstIdx + 1);
        if (secondIdx !== -1) {
            let count = 2, p = original.indexOf(oldStr, secondIdx + 1);
            while (p !== -1) { count++; p = original.indexOf(oldStr, p + 1); }
            const l1 = original.slice(0, firstIdx).split('\n').length;
            const l2 = original.slice(0, secondIdx).split('\n').length;
            throw new ToolError('匹配 old', `old 出现 ${count} 次（第 ${l1}、${l2} 行），不唯一`, '请在 old 中增加上下文（前后多包含几行）使其唯一');
        }

        const lineNo = original.slice(0, firstIdx).split('\n').length;
        if (!autoMode) {
            const preview = `<div style="font-size:11px;color:#888;">替换位置：第 ${lineNo} 行</div>
                <div style="display:flex;gap:8px;margin-top:8px;"><div style="flex:1;background:#000;padding:8px;color:#f87171;max-height:180px;overflow:auto;white-space:pre-wrap;font-family:ui-monospace,monospace;font-size:11px;">${esc(oldStr.slice(0, 800))}</div><div style="flex:1;background:#000;padding:8px;color:#4ade80;max-height:180px;overflow:auto;white-space:pre-wrap;font-family:ui-monospace,monospace;font-size:11px;">${esc(newStr.slice(0, 800))}</div></div>`;
            if (!await showConfirmDialog('编辑文件', path, reason, preview))
                throw new ToolError('用户确认', '用户取消了编辑', '');
        }

        const wr = await fsCall('writefile', { path, content: original.slice(0, firstIdx) + newStr + original.slice(firstIdx + oldStr.length) });
        if (!wr.ok) throw new ToolError('写入文件', wr.error, '');
        return `替换成功（第 ${lineNo} 行，${oldStr.length} 字符 → ${newStr.length} 字符）`;
    }

    async function toolEditLine(call, reason) {
        const { path, line, mode, content } = call;
        if (!path) throw new ToolError('参数校验', '缺少 path', '');
        const lineNo = parseInt(line, 10);
        if (isNaN(lineNo) || lineNo < 1) throw new ToolError('参数校验', 'line 必须为正整数', '');
        if (mode !== 'delete' && content === undefined) throw new ToolError('参数校验', '缺少 content', '');

        const rd = await fsCall('read', { path });
        if (!rd.ok) throw new ToolError('检查路径', `文件不存在或不是文件: ${path}`, rd.error);
        const lines = rd.result.split('\n');
        const idx = lineNo - 1;

        if (mode === 'replace') lines[idx] = content;
        else if (mode === 'insert') lines.splice(idx, 0, content);
        else if (mode === 'delete') lines.splice(idx, 1);
        else throw new ToolError('参数校验', 'mode 必须为 replace, insert 或 delete', '');

        if (!autoMode) {
            const preview = `<div style="font-size:11px;color:#888;">操作：第 ${lineNo} 行 ${mode}</div>
                <div style="background:#000;padding:8px;color:#4ade80;max-height:180px;overflow:auto;white-space:pre-wrap;font-family:ui-monospace,monospace;font-size:11px;">${esc(content || '(删除)')}</div>`;
            if (!await showConfirmDialog('按行编辑', path, reason, preview))
                throw new ToolError('用户确认', '用户取消了按行编辑', '');
        }

        const wr = await fsCall('writefile', { path, content: lines.join('\n') });
        if (!wr.ok) throw new ToolError('写入文件', wr.error, '');
        return `已执行 ${mode} (第 ${lineNo} 行)`;
    }

    async function toolReplaceAll(call, reason) {
        if (!call.find) throw new ToolError('参数校验', '缺少 find', '');
        if (call.replace === undefined) throw new ToolError('参数校验', '缺少 replace', '');
        const target = call.path || '.';
        if (!autoMode) {
            if (!await showConfirmDialog('批量替换', target, reason, `<div style="font-size:11px;color:#888;">将把 "${esc(call.find)}" 替换为 "${esc(String(call.replace))}"</div>`))
                throw new ToolError('用户确认', '用户取消了批量替换', '');
        }
        const r = await fsCall('replaceall', { path: target, find: call.find, replace: call.replace });
        if (!r.ok) throw new ToolError('批量替换', r.error, '确认目录下文件可写、未被占用');
        return r.result;
    }

    async function toolDel(call, reason) {
        if (!call.path) throw new ToolError('参数校验', '缺少 path', '');
        const st = await fsCall('stat', { path: call.path });
        if (!st.ok) throw new ToolError('检查路径', `路径不存在: ${call.path}`, st.error);
        const isDir = st.result.startsWith('类型: 目录');
        if (!autoMode && !await showConfirmDialog(isDir ? '删除目录' : '删除文件', call.path, reason))
            throw new ToolError('用户确认', '用户取消了删除', '');
        const r = await fsCall('del', { path: call.path });
        if (!r.ok) throw new ToolError('删除', r.error, '目录非空需递归删除，或先用 exec');
        return r.result;
    }

    async function toolExec(call, reason) {
        if (!call.command) throw new ToolError('参数校验', '缺少 command', '');

        const cwd = call.cwd || absPath;
        const timeout = call.timeout ? parseInt(call.timeout, 10) : 30000;
        try {
            const resp = await agentFetch('/exec', { command: call.command, cwd, timeout }, timeout + 5000);
            if (!resp.ok) {
                const err = await resp.json().catch(() => ({}));
                throw new ToolError('本地服务', err.error || `HTTP ${resp.status}`, err.hint || '检查 absPath 与 token');
            }
            const data = await resp.json();
            return `输出:\n\`\`\`\n${data.output || '(无输出)'}\n\`\`\`\n(退出码:${data.exitCode})`;
        } catch (e) {
            if (e instanceof ToolError) throw e;
            throw stepErr('调用本地服务', e, '请确认 node server.js 已启动、token 正确、cwd 存在');
        }
    }

    async function toolMove(call) {
        const { from, to } = call;
        if (!from) throw new ToolError('参数校验', '缺少 from（源路径）', '');
        if (!to) throw new ToolError('参数校验', '缺少 to（目标路径）', '');
        const r = await fsCall('move', { from, to });
        if (!r.ok) throw new ToolError('移动', r.error, '可尝试先 copy 再 del');
        return r.result;
    }

    async function toolCopy(call) {
        const { from, to } = call;
        if (!from) throw new ToolError('参数校验', '缺少 from', '');
        if (!to) throw new ToolError('参数校验', '缺少 to', '');
        const r = await fsCall('copy', { from, to });
        if (!r.ok) throw new ToolError('复制', r.error, '检查父目录是否存在');
        return r.result;
    }

    async function toolStat(call) {
        if (!call.path) throw new ToolError('参数校验', '缺少 path', '');
        const r = await fsCall('stat', { path: call.path });
        if (!r.ok) throw new ToolError('检查路径', `路径不存在: ${call.path}`, r.error);
        return r.result;
    }

    async function toolDiff(call) {
        if (!call.path1 || !call.path2) throw new ToolError('参数校验', '需要 path1 和 path2', '');
        const r = await fsCall('diff', { path1: call.path1, path2: call.path2 });
        if (!r.ok) throw new ToolError('对比文件', r.error, '');
        return r.result;
    }

    async function toolHash(call) {
        if (!call.path) throw new ToolError('参数校验', '缺少 path', '');
        const r = await fsCall('hash', { path: call.path });
        if (!r.ok) throw new ToolError('计算哈希', r.error, '');
        return r.result;
    }

    async function toolRestore(call, reason) {
        if (!call.path) throw new ToolError('参数校验', '缺少 path', '');
        if (!autoMode) {
            if (!await showConfirmDialog('从备份恢复', call.path, reason))
                throw new ToolError('用户确认', '用户取消了恢复', '');
        }
        const r = await fsCall('restore', { path: call.path });
        if (!r.ok) throw new ToolError('恢复备份', r.error, '请确认该文件存在 .bak 备份');
        return r.result;
    }

    async function toolWaitFile(call) {
        if (!call.path) throw new ToolError('参数校验', '缺少 path', '');
        const timeout = call.timeout ? parseInt(call.timeout, 10) : 30000;
        const start = Date.now();
        while (Date.now() - start < timeout) {
            const r = await fsCall('stat', { path: call.path });
            if (r.ok) return `文件已出现: ${call.path}`;
            await sleep(500);
        }
        throw new ToolError('等待超时', `文件 ${call.path} 在 ${timeout}ms 内未出现`, '');
    }

    async function toolAsk(call, reason) {
        if (!call.question) throw new ToolError('参数校验', '缺少 question', '');
        if (!call.options?.length) throw new ToolError('参数校验', 'options 为空', '至少提供一个选项');
        const res = await showAskDialog(call.question, call.options, reason);
        if (res.cancel) throw new ToolError('用户确认', '用户取消了回答', '');
        return `用户回复: ${res.choice}`;
    }

    async function toolPreview(call, msgEl) {
        if (!call.path) throw new ToolError('参数校验', '缺少 path', '');
        const rd = await fsCall('read', { path: call.path });
        if (!rd.ok) throw new ToolError('检查路径', `文件不存在: ${call.path}`, rd.error);
        const c = rd.result;
        let html = c;
        if (/\.(md|markdown)$/i.test(call.path)) {
            html = `<!doctype html><html><head><meta charset="utf-8"><style>body{font-family:system-ui;padding:16px;line-height:1.6;background:#fff;color:#222}pre{white-space:pre-wrap;word-wrap:break-word}</style></head><body><pre>${esc(c)}</pre></body></html>`;
        }
        const blobUrl = URL.createObjectURL(new Blob([html], { type: 'text/html' }));
        const win = window.open(blobUrl, '_blank');
        if (!win) {
            const iframe = document.createElement('iframe');
            iframe.src = blobUrl;
            iframe.style.cssText = 'width:100%;height:400px;border:1px solid #444;border-radius:8px;margin-top:10px;background:#fff;';
            msgEl?.appendChild(iframe);
        }
        setTimeout(() => URL.revokeObjectURL(blobUrl), 60000);
        return `预览已打开: ${call.path}`;
    }

    async function toolOpenurl(call) {
        if (!call.url) throw new ToolError('参数校验', '缺少 url', '');
        window.open(call.url, '_blank');
        return `已打开: ${call.url}`;
    }

    async function toolImage(call, msgEl) {
        if (!call.path) throw new ToolError('参数校验', '缺少 path', '');
        const r = await fsCall('readb64', { path: call.path });
        if (!r.ok) throw new ToolError('检查路径', `文件不存在: ${call.path}`, r.error);
        const dataUrl = r.result;
        const img = document.createElement('img');
        img.src = dataUrl;
        img.style.cssText = 'max-width:100%;border-radius:8px;margin-top:8px;';
        msgEl?.appendChild(img);
        return `图片已展示: ${call.path}`;
    }

    // ===== 往输入框拖入文件（模拟 DataTransfer + drop 事件）=====
    async function fetchFileAsFile(relPath) {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 120000);
        try {
            const headers = { 'Content-Type': 'application/json' };
            if (agentToken) headers['X-Agent-Token'] = agentToken;
            const resp = await fetch('http://127.0.0.1:39999/download', {
                method: 'POST', headers, body: JSON.stringify({ path: relPath }), signal: ctrl.signal,
            });
            if (!resp.ok) {
                let msg = 'HTTP ' + resp.status;
                try { const j = await resp.json(); msg = j.error || msg; } catch {}
                throw new Error(msg);
            }
            const blob = await resp.blob();
            const name = relPath.split(/[\\/]/).pop();
            return new File([blob], name, { type: blob.type || 'application/octet-stream', lastModified: Date.now() });
        } finally {
            clearTimeout(timer);
        }
    }

    function findDropZone() {
        const ta = pick(SEL.textarea);
        if (!ta) return null;
        // 优先找到真正监听 drop 的上层容器；逐级向上找带 class 的包裹层
        let node = ta;
        for (let i = 0; i < 6 && node; i++) {
            if (node.getAttribute && (node.getAttribute('role') === 'textbox' || node.className)) {
                // 停在输入区大容器
                const par = node.parentElement;
                if (par) node = par;
            }
            node = node ? node.parentElement : null;
        }
        return ta.closest('div[class]') || ta.parentElement || ta;
    }

    function dispatchDropFiles(zone, files) {
        const dt = new DataTransfer();
        for (const f of files) dt.items.add(f);
        const baseOpt = { bubbles: true, cancelable: true, composed: true, dataTransfer: dt };
        const evs = ['dragenter', 'dragover', 'drop'];
        for (const t of evs) {
            try {
                const ev = new DragEvent(t, baseOpt);
                // 某些属性在 DragEvent 构造里不一定能设，兜底 defineProperty
                Object.defineProperty(ev, 'dataTransfer', { value: dt, writable: false });
                zone.dispatchEvent(ev);
            } catch (e) {
                // 退化为普通 Event 手动挂 dataTransfer
                const ev = new Event(t, { bubbles: true, cancelable: true });
                try { Object.defineProperty(ev, 'dataTransfer', { value: dt }); } catch {}
                zone.dispatchEvent(ev);
            }
        }
    }

    async function toolAttach(call) {
        const pathsRaw = call.paths || call.path || readExtra(call, 'paths') || '';
        if (!pathsRaw) throw new ToolError('参数校验', '缺少 path/paths', '可填多个，用逗号分隔，如 <paths>a.png,b.pdf</paths>');
        const list = String(pathsRaw).split(/[,;\n]/).map(s => s.trim()).filter(Boolean);
        if (!list.length) throw new ToolError('参数校验', '路径为空', '');

        const files = [];
        for (const p of list) {
            try {
                const f = await fetchFileAsFile(p);
                files.push(f);
            } catch (e) {
                throw new ToolError('读取文件', p + ': ' + e.message, '确认文件在工作区内且小于 200MB；server 需重启以启用 /download');
            }
        }

        const zone = findDropZone();
        if (!zone) throw new ToolError('定位输入框', '找不到聊天输入区', '页面可能未就绪，稍后重试');

        dispatchDropFiles(zone, files);
        await sleep(400);

        const totalKB = files.reduce((s, f) => s + f.size, 0) / 1024;
        return '已向输入框拖入 ' + files.length + ' 个文件（共 ' + totalKB.toFixed(1) + 'KB）：\n' +
            files.map(f => '- ' + f.name + ' (' + f.type + ', ' + (f.size/1024).toFixed(1) + 'KB)').join('\n') +
            '\n请检查输入框是否已出现文件附件，确认无误后可再调用 send_message 或手动发送。';
    }

    async function toolSendMessage(call) {
        const text = call.content != null ? String(call.content) : (call.text != null ? String(call.text) : '');
        const r = await sendMessage(text, 15000);
        if (!r.ok) throw new ToolError('发送消息', r.reason || '发送失败', '确认输入框就绪、发送按钮可用');
        return '消息已发送（' + text.length + ' 字符）' + (text ? '' : '（仅附件，无文字）');
    }

    async function toolFetch(call) {
        if (!call.url) throw new ToolError('参数校验', '缺少 url', '');
        try { new URL(call.url); } catch { throw new ToolError('参数校验', `URL 无效: ${call.url}`, '需以 http:// 或 https:// 开头'); }

        let headersObj = {};
        if (call.headers) {
            try { headersObj = JSON.parse(call.headers); } catch { throw new ToolError('参数校验', 'headers 必须是合法的 JSON 字符串', ''); }
        }

        try {
            const resp = await agentFetch('/fetch', {
                url: call.url, method: call.method, content: call.content, headers: headersObj,
                saveTo: call.extraArgs?.saveto || call.extraArgs?.saveTo
            }, 40000);
            if (!resp.ok) {
                const err = await resp.json().catch(() => ({}));
                throw new ToolError('本地服务', err.error || `HTTP ${resp.status}`, err.hint || '检查本地服务是否运行、目标是否可达');
            }
            const data = await resp.json();
            if (data.error) throw new ToolError('本地服务', data.error, '检查 saveTo 路径是否在工作区内');
            const t = data.text || '';
            if (data.savedPath) {
                return `HTTP ${call.method} ${call.url}\n状态: ${data.status} ${data.statusText}\n已保存到文件: ${data.savedPath}（${data.bytes} 字节）\n正文预览:\n\`\`\`\n${t.slice(0, 2000)}\n\`\`\`${t.length > 2000 ? `\n...(已截断，共 ${t.length} 字符，完整内容见文件)` : ''}`;
            }
            return `HTTP ${call.method} ${call.url}\n状态: ${data.status} ${data.statusText}\n内容:\n\`\`\`\n${t.slice(0, 5000)}\n\`\`\`${t.length > 5000 ? `\n...(已截断，共 ${t.length} 字符)` : ''}`;
        } catch (e) {
            if (e instanceof ToolError) throw e;
            log(`本地服务 /fetch 不可用（${e.message}），回退到浏览器 fetch`);
        }

        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 30000);
        try {
            const opts = { method: call.method, signal: ctrl.signal, headers: headersObj };
            if (call.content && call.method !== 'GET' && call.method !== 'HEAD') opts.body = call.content;
            const resp = await fetch(call.url, opts);
            const t = await resp.text();
            return `HTTP ${call.method} ${call.url}\n状态: ${resp.status} ${resp.statusText}\n内容:\n\`\`\`\n${t.slice(0, 5000)}\n\`\`\`${t.length > 5000 ? `\n...(已截断，共 ${t.length} 字符)` : ''}`;
        } catch (e) {
            if (e.name === 'AbortError') throw stepErr('HTTP 请求', new Error('超时（30s）'), '检查网络或目标是否可达');
            throw stepErr('HTTP 请求', e, '浏览器 fetch 失败（可能跨域）；请确认本地服务已启动以启用代理');
        } finally { clearTimeout(timer); }
    }

    async function toolClipboard(call) {
        if (call.text === undefined || call.text === null) throw new ToolError('参数校验', '缺少 text', '');
        try { await navigator.clipboard.writeText(call.text); }
        catch (e) { throw stepErr('写入剪贴板', e, '浏览器可能拒绝剪贴板权限'); }
        return `已复制 ${call.text.length} 字符到剪贴板`;
    }

    async function toolRegisterPlugin(call) {
        const name = call.plugin_name || (call.extraArgs && call.extraArgs.plugin_name);
        const jsCode = call.plugin_js || (call.extraArgs && call.extraArgs.plugin_js);

        if (!name || !jsCode) {
            throw new ToolError('参数校验', '缺少 plugin_name 或 plugin_js', '请提供插件名称和执行代码');
        }
        const pluginName = name.toLowerCase().replace(/[^a-z0-9_]/g, '');
        if (!pluginName) throw new ToolError('参数校验', 'plugin_name 格式非法', '只能包含字母、数字和下划线');

        try {
            // 用 Function 执行 AI 写的代码，返回一个 JS 对象 { name, description, execute }
            const factory = new Function(`return (${jsCode});`);
            const pluginObj = factory();

            if (typeof pluginObj !== 'object' || typeof pluginObj.execute !== 'function') {
                throw new Error('插件必须返回一个包含 execute 函数的对象');
            }

            // 强制覆盖名称，防止 AI 写错
            pluginObj.name = pluginName;
            if (!pluginObj.description) pluginObj.description = 'AI 动态生成的插件';

            // 避免重复注册（覆盖时先清理旧的 UI 挂载）
            const existingIdx = W.DS_Agent_Plugins.findIndex(p => p.name === pluginName);
            if (existingIdx >= 0) {
                try { W.DS_UI_Slots.removeItem('plg_' + pluginName + '_btn'); } catch {}
                try { W.DS_UI_Slots.removeItem('plg_' + pluginName + '_tg'); } catch {}
                try { delete W.DS_ToolRenderers[pluginName]; } catch {}
                W.DS_Agent_Plugins[existingIdx] = pluginObj;
            } else {
                W.DS_Agent_Plugins.push(pluginObj);
            }

            // ===== 处理插件自带的 UI 挂载 =====
            const uiInfo = [];
            const ui = pluginObj.ui;
            if (ui && typeof ui === 'object') {
                // 1. 工具栏按钮
                if (Array.isArray(ui.toolbar)) {
                    ui.toolbar.forEach((cfg, idx) => {
                        if (!cfg || typeof cfg.onClick !== 'function') return;
                        const btnId = 'plg_' + pluginName + '_btn' + (idx ? idx : '');
                        W.DS_UI_Slots.addButton({
                            id: btnId,
                            label: cfg.label || pluginName,
                            icon: cfg.icon || '',
                            title: cfg.title || '',
                            slot: 'toolbar',
                            onClick: (btnEl) => cfg.onClick(btnEl, pluginObj),
                        });
                        uiInfo.push('工具栏按钮「' + (cfg.label || pluginName) + '」');
                    });
                }
                // 2. 开关
                if (Array.isArray(ui.toggle)) {
                    ui.toggle.forEach((cfg, idx) => {
                        if (!cfg || typeof cfg.onChange !== 'function') return;
                        const tgId = 'plg_' + pluginName + '_tg' + (idx ? idx : '');
                        W.DS_UI_Slots.addToggle({
                            id: tgId,
                            label: cfg.label || pluginName,
                            defaultOn: !!cfg.defaultOn,
                            slot: 'toggle',
                            onChange: (state) => cfg.onChange(state, pluginObj),
                        });
                        uiInfo.push('开关「' + (cfg.label || pluginName) + '」');
                    });
                }
                // 3. 工具折叠详情自定义渲染
                if (typeof ui.renderTool === 'function') {
                    W.DS_ToolRenderers[pluginName] = (call) => {
                        try { return ui.renderTool(call, pluginObj); } catch (e) { return '<div style="color:#f25a5a">渲染出错: ' + esc(e.message) + '</div>'; }
                    };
                    uiInfo.push('工具详情自定义渲染');
                }
            }

            const uiSuffix = uiInfo.length ? ('\n已挂载 UI：' + uiInfo.join('、')) : '';
            return (existingIdx >= 0 ? `插件 "${pluginName}" 已更新成功。` : `插件 "${pluginName}" 注册成功！`) +
                uiSuffix + '\n请直接在当前对话的下一轮调用该插件。';

        } catch (e) {
            throw new ToolError('编译插件', e.message || String(e), '请确保 plugin_js 是合法的 JavaScript 对象字面量');
        }
    }

    async function toolReloadServerPlugins(call) {
        try {
            const resp = await agentFetch('/plugins/reload', {}, 5000);
            if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
            const data = await resp.json();
            W.serverPlugins = data.plugins || [];
            return `服务端插件重载成功！当前共加载 ${W.serverPlugins.length} 个插件：\n` +
                   W.serverPlugins.map(p => `- ${p.name}`).join('\n');
        } catch (e) {
            throw new ToolError('重载插件', e.message, '请确保服务端正在运行');
        }
    }

    async function toolKillProcess(call) {
        const pid = call.pid || (call.extraArgs && call.extraArgs.pid);
        if (!pid) throw new ToolError('参数校验', '缺少 pid', '请提供要终止的进程 PID');
        try {
            const resp = await agentFetch('/exec/kill', { pid }, 5000);
            if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
            const data = await resp.json();
            return data.output;
        } catch (e) {
            throw new ToolError('终止进程', e.message, '请检查服务端状态');
        }
    }

    async function toolSleep(call) {
        const ms = parseInt(call.timeout ?? call.ms ?? 1000, 10);
        if (isNaN(ms) || ms < 0) throw new ToolError('参数校验', 'timeout 必须为非负整数毫秒', '例如 1000');
        if (ms > 300000) throw new ToolError('参数校验', '最大 300000ms（5 分钟）', '需要更长请用 waitfile');
        await sleep(ms);
        return `已休眠 ${ms}ms`;
    }

    async function dispatchTool(op, call, msgEl, reason) {
        switch (op) {
            case 'listdir': return toolListdir(call);
            case 'openfile': return toolOpenfile(call);
            case 'mkdir': return toolMkdir(call);
            case 'grep': return toolGrep(call);
            case 'glob': return toolGlob(call);
            case 'search': return toolSearch(call);
            case 'tree': return toolTree(call);
            case 'batch': return toolBatch(call, reason);
            case 'backups': return toolBackups(call);
            case 'audit': return toolAudit(call);
            case 'cleanbaks': return toolCleanbaks(call, reason);
            case 'attach': return toolAttach(call);
            case 'send_message': return toolSendMessage(call);
            case 'writefile': return toolWritefile(call, reason);
            case 'append': return toolAppend(call, reason);
            case 'edit': return toolEdit(call, reason);
            case 'editline': return toolEditLine(call, reason);
            case 'replaceall': return toolReplaceAll(call, reason);
            case 'del': return toolDel(call, reason);
            case 'move': return toolMove(call);
            case 'copy': return toolCopy(call);
            case 'stat': return toolStat(call);
            case 'diff': return toolDiff(call);
            case 'hash': return toolHash(call);
            case 'readb64': {
                if (!call.path) throw new ToolError('参数校验', '缺少 path', '');
                const r = await fsCall('readb64', { path: call.path });
                if (!r.ok) throw new ToolError('读取文件', r.error, '请确认文件存在且为图片');
                const url = String(r.result || '');
                // 防止超大 base64 撑爆上下文：超过 60KB 只回报摘要，展示请用 image 工具
                if (url.length > 60000) {
                    return `文件 ${call.path} 的 data URL 过大（${url.length} 字符），已省略。如需在页面展示请改用 image 工具。\n前缀: ${url.slice(0, 80)}...`;
                }
                return url;
            }
            case 'waitfile': return toolWaitFile(call);
            case 'ask': return toolAsk(call, reason);
            case 'exec': return toolExec(call, reason);
            case 'preview': return toolPreview(call, msgEl);
            case 'openurl': return toolOpenurl(call);
            case 'image': return toolImage(call, msgEl);
            case 'fetch': return toolFetch(call);
            case 'restore': return toolRestore(call, reason);
            case 'clipboard': return toolClipboard(call);
            case 'sleep': return toolSleep(call);
            case 'gettime': return `当前系统时间: ${new Date().toLocaleString('zh-CN', { hour12: false })}`;
            case 'register_plugin': return toolRegisterPlugin(call);
            case 'kill_process': return toolKillProcess(call);
            case 'reload_server_plugins': return toolReloadServerPlugins(call);
            default: {
                // 1. 尝试在前端社区插件中查找
                if (W.DS_Agent_Plugins) {
                    const plugin = W.DS_Agent_Plugins.find(p => p.name.toLowerCase() === op);
                    if (plugin && typeof plugin.execute === 'function') {
                        try {
                            const result = await plugin.execute(call);
                            return String(result);
                        } catch (e) {
                            throw new ToolError('前端插件执行', e.message || String(e), '请检查插件代码');
                        }
                    }
                }
                
                // 2. 尝试在后端服务端插件中查找
                if (W.serverPlugins && W.serverPlugins.some(p => p.name === op)) {
                    try {
                        const resp = await agentFetch('/plugins/exec', { name: op, args: call }, 60000);
                        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
                        const data = await resp.json();
                        if (data.error) throw new Error(data.error);
                        return data.result;
                    } catch (e) {
                        throw new ToolError('服务端插件执行', e.message, '请检查本地服务端和插件代码');
                    }
                }
                
                throw new ToolError('分发', `未知工具 "${op}"`, '检查工具名拼写');
            }
        }
    }

    async function executeOne(call, msgEl) {
        const op = String(call.op || '').toLowerCase();
        const sig = toolcallSignature(call);
        currentForce = /^(true|1|yes)$/i.test(readExtra(call, 'force'));
        toolcallStatusMap.set(sig, 'running');
        updateFoldUI();
        try {
            const msg = await dispatchTool(op, call, msgEl, call.reason);
            toolcallStatusMap.set(sig, 'success');
            updateFoldUI();
            return { op, path: call.path, status: 'ok', msg };
        } catch (e) {
            const isCancel = e instanceof ToolError && e.dsStep === '用户确认';
            const detailed = e instanceof ToolError
                ? formatToolError(op, call, e)
                : `[失败] ${op}\n原因: ${e.message}\n参数: ${describeParams(call)}`;
            toolcallStatusMap.set(sig, isCancel ? 'queue' : 'error');
            updateFoldUI();
            if (!isCancel) {
                showToast('error', `[失败] ${op} 执行出错`, 4000);
            }
            return { op, path: call.path, status: isCancel ? 'cancel' : 'error', msg: detailed };
        }
    }

    function updateFoldUI() {
        document.querySelectorAll('.ds-fold-item[data-call-sig]').forEach(item => {
            const sig = item.getAttribute('data-call-sig');
            const status = toolcallStatusMap.get(sig) || 'queue';
            let icon = I.circle, color = '#888';
            if (status === 'running') { icon = I.circleSpin; color = '#eab308'; }
            else if (status === 'success') { icon = I.check; color = '#4CAF50'; }
            else if (status === 'error') { icon = I.close; color = '#d32f2f'; }

            const statusSpan = item.querySelector('.ds-fold-status');
            if (statusSpan) {
                if (!statusSpan.getAttribute('data-state') || statusSpan.getAttribute('data-state') !== status) {
                    statusSpan.innerHTML = icon;
                    statusSpan.style.color = color;
                    statusSpan.setAttribute('data-state', status);
                }
            }
        });
    }

    function packResults(results) {
        let text = "【系统执行结果】\n";
        for (const r of results) {
            const tag = r.status === "error" ? "[失败]" : (r.status === "cancel" ? "[取消]" : "[成功]");
            text += tag + " " + r.op + (r.path ? " (" + r.path + ")" : "") + ":" + "\n" + r.msg + "\n\n";
        }
        // 插话：用户在执行期间输入的内容，随本次结果一并送达 AI
        if (interjectQueue.length > 0) {
            text += "【用户插话】\n";
            interjectQueue.forEach((msg, i) => { text += (i + 1) + ". " + msg + "\n"; });
            text += "（以上是用户在任务执行过程中补充的指令，请在继续操作时纳入考虑）\n\n";
            interjectQueue.length = 0;
            try { renderInterjectPending(); } catch {}
        }
        text += [
            "【每轮必读·格式自查】",
            "1. 每个工具调用都必须包在三反引号代码块里（开头 ```toolcall，结尾 ```），块内放完整 <toolcall>...</toolcall>。",
            "2. 代码块外裸写 <toolcall> 会被系统直接拒绝，本轮调用白费。",
            "3. 发送前自查：你写的每个 <toolcall> 前面是不是都有 ```toolcall 那一行？结尾有没有三个反引号？",
            "4. 多个调用 = 多个独立的 ```toolcall 代码块，不要塞进同一个块。",
            "示例（照抄这个结构）：```toolcall / <toolcall> / <op>工具名</op> / <参数>值</参数> / </toolcall> / ```"
        ].join("\n");
        return text;
    }

    function showProgress(total) {
        const wrap = document.getElementById('ds-progress-wrap');
        if (!wrap) return;
        wrap.style.display = 'flex';
        setProgress(0, total, '准备执行');
    }
    function setProgress(done, total, text) {
        const wrap = document.getElementById('ds-progress-wrap');
        const bar = document.getElementById('ds-progress-bar');
        const cnt = document.getElementById('ds-progress-count');
        const txt = document.getElementById('ds-progress-text');
        if (!wrap) return;
        if (txt && text) txt.textContent = text;
        if (cnt) cnt.textContent = done + '/' + total;
        if (bar) bar.style.width = (total ? Math.round(done / total * 100) : 0) + '%';
    }
    function hideProgress() {
        const wrap = document.getElementById('ds-progress-wrap');
        if (wrap) { wrap.style.display = 'none'; }
        const bar = document.getElementById('ds-progress-bar');
        if (bar) bar.style.width = '0%';
    }

    function renderInterjectPending() {
        const el = document.getElementById('ds-interject-pending');
        if (!el) return;
        if (interjectQueue.length === 0) {
            el.style.display = 'none';
            el.innerHTML = '';
        } else {
            el.style.display = 'block';
            el.innerHTML = '<b>待发送插话 (' + interjectQueue.length + ')</b><br>' +
                interjectQueue.map((m, i) => (i + 1) + '. ' + esc(m)).join('<br>');
        }
    }

    function pushInterject(msg) {
        const m = String(msg || '').trim();
        if (!m) return false;
        interjectQueue.push(m);
        try { renderInterjectPending(); } catch {}
        return true;
    }


    async function tryProcess() {
        // 扫描所有已结束的 assistant 消息，收集其中尚未执行的 toolcall
        // （修复：只取最后一条消息时，末条消息渲染晚导致其尾部 toolcall 永久丢包）
        const items = pickAll(SEL.virtualItem);
        const toExec = [];
        for (const item of items) {
            if (!pick(SEL.assistantContent, item)) continue;
            const key = item.getAttribute('data-virtual-list-item-key');
            if (!key) continue;
            if (ignoreKeys.has(key)) continue; // 「当前对话内开始」启动时已存在的消息：不执行其工具调用
            const st = msgStore.get(key);
            if (!st || !st.done) continue;
            const parsed = parseToolcalls(item);
            if (parsed.invalidTexts && parsed.invalidTexts.length > 0) {
                // 发现裸 XML：拦截并报错
                const sig = '__invalid_format__' + item.getAttribute('data-virtual-list-item-key');
                if (!st.sigs.has(sig)) {
                    st.sigs.add(sig);
                    showToast('warning', '检测到裸 XML 工具调用，已拒绝并要求 AI 重发', 5000);
                    log('⚠ 检测到未包裹代码块的裸 XML，已拦截');
                    toExec.push({ 
                        call: { op: '__format_error__', path: '' }, 
                        st, sig, item,
                        customResult: {
                            op: '__format_error__',
                            path: '',
                            status: 'error',
                            msg: '[格式错误] 本次调用被拒绝！\n\n你输出了未用 ```toolcall 代码块包裹的裸 XML，系统无法执行。\n\n【必须修正】把完整的 <toolcall>...</toolcall> 放在三反引号包裹的代码块中，代码块语言标记写 toolcall，例如：\n\n```toolcall\n<toolcall>\n  <op>listdir</op>\n  <path>.</path>\n</toolcall>\n```\n\n请严格按此格式重新发送你要执行的工具调用。'
                        }
                    });
                }
                continue; // 忽略解析出的正常 calls
            }

            const allCalls = parsed.calls;
            if (!allCalls.length) continue;
            for (const call of allCalls) {
                const sig = toolcallSignature(call);
                if (st.sigs.has(sig)) continue;
                toExec.push({ call, st, sig, item });
            }
        }
        if (!toExec.length) return;

        // 连续执行达到上限后，下一批开始前强制冷却，避免请求频率过高被封控
        if (autoThrottle && toolcallCounter >= BATCH_LIMIT) {
            isCoolingDown = true;
            isProcessing = true;              // 冷却期间占住处理锁，防止 poll 重入
            processingStart = Date.now();
            const sec = Math.round(BATCH_COOLDOWN_MS / 1000);
            log(`⚠ 已连续执行 ${toolcallCounter} 个工具，暂停 ${sec}s 冷却后再继续（防频率限制）`);
            dsSetStatus('working', `防封控冷却中 ${sec}s`);
            showToast('warning', `频率保护：已连续执行 ${toolcallCounter} 个工具，暂停 ${sec} 秒冷却...`, 3000);
            await sleep(BATCH_COOLDOWN_MS);
            toolcallCounter = 0;
            isCoolingDown = false;
            isProcessing = false;
            processingStart = 0;
            log('冷却结束，继续执行');
            showToast('success', '冷却结束，继续执行任务', 2000);
        }

        isProcessing = true;
        processingStart = Date.now();
        lastExecTime = Date.now();
        dsSetStatus('working', '执行中...');

        const results = [];
        const SLOW_OPS = ['sleep', 'waitfile', 'exec', 'fetch', 'ask'];
        // 只读工具可并发执行，提升批次速度（结果仍按原顺序回填）
        const READONLY_OPS = new Set(['listdir', 'openfile', 'grep', 'glob', 'stat', 'hash', 'diff', 'gettime']);

        const runOne = async (entry) => {
            const call = entry.call;
            const sig = entry.sig;
            const st = entry.st;

            if (entry.customResult) {
                st.sigs.add(sig);
                log(`→ error: 发现裸 XML 格式错误`);
                return entry.customResult;
            }

            toolcallCounter++;
            log(`执行 ${call.op} ${displayFor(call)}`);
            let result;
            const NEEDS_CONFIRM = ['ask'];
            const isConfirmOp = NEEDS_CONFIRM.includes(call.op) ||
                (!autoMode && ['writefile', 'append', 'edit', 'editline', 'replaceall', 'del'].includes(call.op));
            let TOOL_TIMEOUT_MS = 5000;
            const isServerPlugin = W.serverPlugins && W.serverPlugins.some(p => p.name === call.op);
            if (isConfirmOp) {
                TOOL_TIMEOUT_MS = 0;
            } else if (isServerPlugin) {
                // 服务端插件（如 TTS、下载大文件等）可能耗时较长，给予 5 分钟超时
                TOOL_TIMEOUT_MS = 5 * 60 * 1000;
            } else if (SLOW_OPS.includes(call.op)) {
                const ut = call.timeout ? parseInt(call.timeout, 10) : 0;
                if (call.op === 'sleep' || call.op === 'waitfile') TOOL_TIMEOUT_MS = (ut || 30000) + 2000;
                else if (call.op === 'exec') TOOL_TIMEOUT_MS = (ut || 30000) + 10000;
                else if (call.op === 'fetch') TOOL_TIMEOUT_MS = 45000;
                else TOOL_TIMEOUT_MS = 5 * 60 * 1000;
            }
            try {
                if (TOOL_TIMEOUT_MS === 0) {
                    result = await executeOne(call, entry.item);
                } else {
                    let _toTimer = null;
                    const timeoutPromise = new Promise((_, reject) => {
                        _toTimer = setTimeout(() => reject(new Error(`工具执行超时 (${TOOL_TIMEOUT_MS}ms)，可能是浏览器文件 API 卡死`)), TOOL_TIMEOUT_MS);
                    });
                    try {
                        result = await Promise.race([executeOne(call, entry.item), timeoutPromise]);
                    } finally {
                        clearTimeout(_toTimer);
                    }
                }
                if (['writefile', 'append', 'edit', 'editline', 'replaceall', 'move', 'copy'].includes(call.op)) {
                    await sleep(50);
                }
            } catch (e) {
                result = { op: call.op, path: call.path, status: 'error', msg: `[失败] ${call.op}\n原因: ${e.message}` };
            }
            st.sigs.add(sig);
            log(`→ ${result.status}: ${String(result.msg).split('\n')[0]}`);
            return result;
        };

        let roBatch = [];
        const flushBatch = async () => {
            if (!roBatch.length) return;
            const cur = roBatch; roBatch = [];
            const rs = await Promise.all(cur.map(e => runOne(e)));
            for (const r of rs) results.push(r);
            progressDone += cur.length;
            setProgress(progressDone, progressTotal, '执行中');
        };

        let progressDone = 0;
        const progressTotal = toExec.length;
        showProgress(progressTotal);
        setProgress(0, progressTotal, '执行中');

        for (const entry of toExec) {
            const op = String(entry.call.op || '').toLowerCase();
            if (!entry.customResult && READONLY_OPS.has(op)) {
                roBatch.push(entry);
            } else {
                await flushBatch();
                results.push(await runOne(entry));
                progressDone++;
                setProgress(progressDone, progressTotal, '执行中');
            }
        }
        await flushBatch();
        setProgress(progressTotal, progressTotal, '执行完成');
        setTimeout(hideProgress, 1200);

        let sent = false, lastReason = '', retryCount = 0;
        const MAX_AUTO_RETRIES = 30; // 最多自动重试 30 次（约 5 分钟），避免死循环
        while (!sent && retryCount < MAX_AUTO_RETRIES) {
            try {
                const r = await sendMessage(packResults(results), 5000);
                sent = r.ok;
                if (!sent) {
                    lastReason = r.reason || '未知';
                    // AI 生成中按钮不可用：不重试，直接转 pendingResults，等生成完再发
                    if (lastReason.includes('按钮') || lastReason.includes('生成')) {
                        log(`回传暂缓（${lastReason}）`);
                        break;
                    }
                }
            } catch (e) {
                lastReason = e.message;
            }
            if (!sent) {
                retryCount++;
                log(`回传失败（${lastReason}），10 秒后自动重试（第 ${retryCount} 次）...`);
                showToast('warning', `网络波动，回传失败。10 秒后自动重试...`, 3000);
                dsSetStatus('working', '自动重试中');
                await sleep(SEND_RETRY_MS);
            }
        }

        isProcessing = false;
        processingStart = 0;

        if (!sent) {
            pendingResults = results;
            pendingRetries = 0;
            pendingLastTry = 0;
            dsSetStatus('working', '回传待重试');
            log(`⚠ 回传失败（${lastReason}），结果已暂存，将自动重发`);
        } else {
            pendingResults = null;
            dsSetStatus('active', '监听中');
        }
        hideProgress();

        isCooldown = true;
        if (cooldownTimer) clearTimeout(cooldownTimer);
        cooldownTimer = setTimeout(() => {
            isCooldown = false;
            if (isModeOn) dsSetStatus('active', '监听中');
            checkAndProcess();
        }, 1500);
    }

    async function checkAndProcess() {
        if (!isModeOn) return;
        if (isPaused) return;
        if (isCoolingDown) return;
        if (isProcessing) {
            // 弹窗等待用户期间不强制复位（用户可能还没点确定）
            if (!awaitingUser && processingStart && Date.now() - processingStart > PROCESS_TIMEOUT) {
                log(`⚠ 上一次工具执行超过 ${PROCESS_TIMEOUT/1000}s 未结束，强制复位`);
                isProcessing = false;
            } else return;
        }
        if (isCooldown || isCompressing) return;

        if (location.href !== currentChatUrl) {
            currentChatUrl = location.href;
            msgStore.clear();
        toolcallStatusMap.clear();
            return;
        }

        scanMessages();

        if (pendingResults) {
            // 时间戳门禁：距上次重发不足 10 秒则跳过，避免轮询期间高频重发
            if (Date.now() - (pendingLastTry || 0) < SEND_RETRY_MS) return;
            pendingLastTry = Date.now();
            if (pendingRetries >= PENDING_MAX_RETRIES) {
                log(`⚠ 回传重试 ${PENDING_MAX_RETRIES} 次仍失败，放弃本次回传`);
                pendingResults = null;
                pendingRetries = 0;
                dsSetStatus('active', '监听中');
                return;
            }
            isProcessing = true;
            processingStart = Date.now();
            const pr = await sendMessage(packResults(pendingResults), 5000);
            isProcessing = false;
            processingStart = 0;
            if (pr.ok) {
                pendingResults = null;
                pendingRetries = 0;
                dsSetStatus('active', '监听中');
            } else {
                pendingRetries++;
                const reason = pr.reason || '';
                if (reason.includes('按钮') || reason.includes('生成')) {
                    dsSetStatus('working', '等待 AI 生成完成...');
                } else {
                    log(`重发失败（${reason}），10 秒后自动重试（${pendingRetries}/${PENDING_MAX_RETRIES}）`);
                    dsSetStatus('working', '自动重试中');
                }
            }
            return;
        }

        if (Date.now() - lastExecTime < 1000) return;
        await tryProcess();
    }

    function startObserver() {
        if (observer) observer.disconnect();
        if (pollInterval) clearInterval(pollInterval);
        let rafPending = false;
        observer = new MutationObserver(() => {
            hideToolResultMessages();
            if (rafPending) return;
            rafPending = true;
            requestAnimationFrame(() => {
                rafPending = false;
                scanMessages();
                foldAllToolcalls();
                if (isModeOn) checkAndProcess();
            });
        });
        observer.observe(document.body, { childList: true, subtree: true, characterData: true });
        pollInterval = setInterval(() => {
            hideToolResultMessages();
            foldAllToolcalls();
            if (isModeOn) checkAndProcess();
        }, 2000);
    }

    function findNewChatButton() {
        for (const el of document.querySelectorAll('span')) {
            if (el.textContent.trim() === '开启新对话') {
                return el.closest('div._7b40dad') || el.closest('a') || el.closest('div');
            }
        }
        return null;
    }

    function injectUI() {
        if (document.getElementById('ds-local-panel')) return true;
        const newChatBtn = findNewChatButton();
        if (!newChatBtn) {
            if (!injectUI._warned) {
                console.warn('[DeepSeek 本地互联] 未找到"开启新对话"按钮，UI 注入失败。页面结构可能已更新。');
                injectUI._warned = true;
            }
            return false;
        }
        injectUI._warned = false;

        const panel = document.createElement('div');
        panel.id = 'ds-local-panel';
        panel.className = 'ds-panel-container';
        panel.innerHTML = `
            <div style="display:flex;align-items:center;justify-content:space-between;">
                <div style="display:flex;align-items:center;font-weight:600;color:var(--dsw-alias-brand-primary,#3964fe);gap:6px;">
                    <span id="ds-dot" class="ds-status-dot"></span>本地互联
                </div>
                <span id="ds-status" style="font-size:12px;color:var(--dsw-alias-label-tertiary,#81858c);">未连接</span>
            </div>
            <div id="ds-setup-container" style="display:flex;flex-direction:column;gap:8px;">
                <div id="ds-abs-container" style="display:none;flex-direction:column;gap:4px;">
                    <span style="font-size:11px;color:#888;line-height:1.4;">工作区目录（AI 将在此目录下操作文件）:</span>
                    <div style="display:flex;gap:6px;align-items:flex-start;">
                        <code id="ds-workspace-path" style="flex:1;font-size:11px;color:#3964fe;text-overflow:ellipsis;white-space:nowrap;overflow:hidden;line-height:1.5;padding:4px 6px;background:rgba(0,0,0,0.25);border-radius:4px;">（尚未选择）</code>
                        <button id="ds-pick-btn" class="ds-btn ds-btn-secondary" style="white-space:nowrap;height:28px;font-size:12px;">选择目录</button>
                    </div>
                    <select id="ds-recent-select" class="ds-input" style="display:none;font-size:11px;margin-top:4px;">
                        <option value="">— 从最近使用的工作区选择 —</option>
                    </select>
                    <span style="font-size:11px;color:#888;line-height:1.4;margin-top:4px;">本地服务 Token（server 启动时打印，可选）:</span>
                    <input id="ds-token-input" class="ds-input" type="password" placeholder="留空表示不使用 token" />
                </div>
                <div id="ds-goal-container" style="display:none;flex-direction:column;gap:6px;">
                    <span style="font-size:11px;color:#888;">本次任务目标:</span>
                    <input id="ds-goal-input" class="ds-input" type="text" placeholder="输入目标（留空则由 AI 自行探索）" />
                    <span style="font-size:11px;color:#888;margin-top:4px;">启动方式:</span>
                    <label style="font-size:12px;color:var(--dsw-alias-label-primary,#f9fafb);display:flex;align-items:center;gap:6px;cursor:pointer;">
                        <input type="radio" name="ds-start-mode" value="new" checked> 在新对话开始（推荐）
                    </label>
                    <label style="font-size:12px;color:var(--dsw-alias-label-primary,#f9fafb);display:flex;align-items:center;gap:6px;cursor:pointer;">
                        <input type="radio" name="ds-start-mode" value="here"> 在当前对话内开始
                    </label>
                    <label id="ds-skip-prompt-label" style="font-size:12px;color:var(--dsw-alias-label-tertiary,#81858c);display:flex;align-items:center;gap:6px;cursor:pointer;padding-left:20px;">
                        <input type="checkbox" id="ds-skip-prompt"> 不再发送系统提示词（直接继续监听，仅「当前对话内开始」生效）
                    </label>
                </div>
                <button id="ds-connect-btn" class="ds-btn ds-btn-primary">开启模式</button>
            </div>
            <div id="ds-main-container" style="display:none;flex-direction:column;gap:8px;">
                <div style="display:flex;gap:6px;align-items:center;">
                    <input id="ds-interject-input" class="ds-input" type="text" placeholder="插话（AI 执行时也会插队到下次结果）" style="flex:1;font-size:12px;" />
                    <button id="ds-interject-btn" class="ds-btn ds-btn-secondary" style="white-space:nowrap;height:28px;font-size:12px;">插话</button>
                </div>
                <div id="ds-interject-pending" style="display:none;font-size:11px;color:#eab308;line-height:1.5;padding:6px 9px;background:rgba(234,179,8,0.08);border:1px solid rgba(234,179,8,0.3);border-left:3px solid #eab308;border-radius:6px;"></div>
                <div id="ds-progress-wrap" style="display:none;flex-direction:column;gap:4px;">
                    <div style="display:flex;justify-content:space-between;font-size:11px;color:var(--dsw-alias-label-tertiary,#81858c);">
                        <span id="ds-progress-text">执行中...</span>
                        <span id="ds-progress-count">0/0</span>
                    </div>
                    <div style="height:4px;background:rgba(255,255,255,0.08);border-radius:2px;overflow:hidden;">
                        <div id="ds-progress-bar" style="height:100%;width:0%;background:var(--dsw-alias-brand-primary,#3964fe);border-radius:2px;transition:width .25s cubic-bezier(.4,0,.2,1);"></div>
                    </div>
                </div>
                <label style="font-size:12px;color:var(--dsw-alias-label-tertiary,#81858c);display:flex;align-items:center;gap:6px;cursor:pointer;">
                    <input type="checkbox" id="ds-auto-toggle"> 完全权限（跳过确认/自动执行命令）
                </label>
                <label style="font-size:12px;color:var(--dsw-alias-label-tertiary,#81858c);display:flex;align-items:center;gap:6px;cursor:pointer;">
                    <input type="checkbox" id="ds-throttle-toggle" checked> 开启防封控冷却（连续10次后暂停）
                </label>
                <div style="display:flex;gap:6px;">
                    <button id="ds-pause-btn" class="ds-btn ds-btn-secondary" style="flex:1;">暂停执行</button>
                    <button id="ds-disconnect-btn" class="ds-btn ds-btn-danger" style="flex:1;">断开连接</button>
                </div>
                <div id="ds-log" class="ds-log-area"></div>
            </div>`;
        newChatBtn.parentNode.insertBefore(panel, newChatBtn.nextSibling);

        const $ = (id) => document.getElementById(id);
        const dot = $('ds-dot'), statusEl = $('ds-status'), logEl = $('ds-log');
        const connectBtn = $('ds-connect-btn'), disconnectBtn = $('ds-disconnect-btn');
        const setupContainer = $('ds-setup-container'), mainContainer = $('ds-main-container');
        const absContainer = $('ds-abs-container'), workspacePathEl = $('ds-workspace-path');
        const tokenInput = $('ds-token-input');
        const pickBtn = $('ds-pick-btn');
        const goalContainer = $('ds-goal-container'), goalInput = $('ds-goal-input');
        const autoToggle = $('ds-auto-toggle');
        const throttleToggle = $('ds-throttle-toggle');
        const pauseBtn = $('ds-pause-btn');
        const recentSelect = $('ds-recent-select');

        window.dsLog = (msg) => {
            const d = document.createElement('div');
            const s = String(msg);
            if (s.startsWith('❌') || s.startsWith('⚠') || s.startsWith('[失败]') || s.includes('失败')) d.className = 'err';
            else if (s.startsWith('→ ok') || s.startsWith('[成功]')) d.className = 'ok';
            d.textContent = `> ${s}`;
            logEl.appendChild(d);
            logEl.scrollTop = logEl.scrollHeight;
        };
        window.dsSetStatus = (state, text) => {
            statusEl.textContent = text;
            dot.className = 'ds-status-dot';
            if (state === 'active') dot.classList.add('active');
            if (state === 'working') dot.classList.add('working');
        };
        const interjectInput = $('ds-interject-input');
        const interjectBtn = $('ds-interject-btn');
        const submitInterject = () => {
            const v = interjectInput.value;
            if (!pushInterject(v)) return;
            interjectInput.value = '';
            log('已加入插话队列，将随下次结果发送');
            // 若当前没有正在进行的处理，立刻触发一次回传把插话送出去
            if (!isProcessing && !isCoolingDown) checkAndProcess();
        };
        interjectBtn.addEventListener('click', submitInterject);
        interjectInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') submitInterject(); });

        autoToggle.addEventListener('change', () => { autoMode = autoToggle.checked; saveState(); });
        throttleToggle.addEventListener('change', () => { autoThrottle = throttleToggle.checked; saveState(); });

        pauseBtn.addEventListener('click', () => {
            isPaused = !isPaused;
            if (isPaused) {
                pauseBtn.textContent = '继续执行';
                dsSetStatus('working', '已暂停');
                log('⏸ 已暂停自动执行（AI 新生成的工具调用将不被执行，直到继续）');
                showToast('warning', '已暂停自动执行', 2500);
            } else {
                pauseBtn.textContent = '暂停执行';
                dsSetStatus('active', '监听中');
                log('▶ 已恢复自动执行');
                showToast('success', '已恢复自动执行', 2000);
                checkAndProcess();
            }
        });

        function refreshRecentSelect() {
            const list = loadRecentWorkspaces();
            if (!list.length) { recentSelect.style.display = 'none'; return; }
            recentSelect.style.display = 'block';
            recentSelect.innerHTML = '<option value="">— 从最近使用的工作区选择 —</option>' +
                list.map(p => `<option value="${esc(p)}">${esc(p)}</option>`).join('');
        }
        recentSelect.addEventListener('change', async () => {
            const p = recentSelect.value;
            if (!p) return;
            try {
                const resp = await agentFetch('/workspace/set', { path: p }, 10000);
                if (!resp.ok) throw new Error('HTTP ' + resp.status);
                const data = await resp.json();
                if (!data.ok) throw new Error(data.error || '切换失败');
                absPath = data.cwd;
                workspacePathEl.textContent = absPath;
                workspacePathEl.title = absPath;
                log('已切换工作区: ' + absPath);
                showToast('success', '工作区已切换', 2000);
            } catch (e) {
                log('切换工作区失败: ' + e.message);
                showToast('error', '切换失败: ' + e.message, 3000);
            }
        });
        refreshRecentSelect();

        async function doPickWorkspace() {
            dsSetStatus('working', '请在弹出的窗口中选择');
            pickBtn.disabled = true;
            const oldTxt = pickBtn.textContent;
            pickBtn.textContent = '等待弹窗...';
            try {
                // 130s，略大于后端 PowerShell 的 120s 超时，确保后端先放弃
                const resp = await agentFetch('/workspace/pick', {}, 130000);
                if (!resp.ok) throw new Error('HTTP ' + resp.status);
                const data = await resp.json();
                if (!data.ok) {
                    dsSetStatus('working', '未选择目录');
                    log(`选择目录: ${data.error || '已取消'}`);
                    return false;
                }
                absPath = data.cwd;
                workspacePathEl.textContent = absPath;
                workspacePathEl.title = absPath;
                addRecentWorkspace(absPath);
                refreshRecentSelect();
                dsSetStatus('working', '目录已选定');
                log(`工作区: ${absPath}`);
                return true;
            } catch (e) {
                const msg = e.message || '';
                if (msg.includes('超时') || msg.includes('timeout') || msg.includes('AbortError')) {
                    dsSetStatus('none', '选择超时');
                    log('选择超时：弹窗可能被系统隐藏或未响应');
                } else {
                    dsSetStatus('none', '选择失败');
                    log('选择目录失败: ' + msg);
                }
                return false;
            } finally {
                pickBtn.disabled = false;
                pickBtn.textContent = oldTxt;
            }
        }

        pickBtn.addEventListener('click', doPickWorkspace);

        connectBtn.addEventListener('click', async () => {
            if (step === 0) {
                step = 1;
                absContainer.style.display = 'flex';
                tokenInput.value = agentToken;
                connectBtn.textContent = '下一步';
                dsSetStatus('working', '选择工作区');
                // 自动探一次当前工作区（不弹框，仅用于展示），用户可再点"选择目录"更换
                try {
                    const resp = await agentFetch('/workspace', {}, 8000);
                    if (resp.ok) {
                        const data = await resp.json();
                        if (data.cwd) {
                            absPath = data.cwd;
                            workspacePathEl.textContent = data.cwd;
                        }
                    } else if (resp.status === 403) {
                        workspacePathEl.textContent = '（需填写正确 Token 后才能获取）';
                    }
                } catch (e) {
                    workspacePathEl.textContent = '（无法连接服务）';
                    workspacePathEl.title = '无法连接服务';
                }
                return;
            }
            if (step === 1) {
                agentToken = tokenInput.value.trim();
                if (agentToken) localStorage.setItem(TOKEN_KEY, agentToken);
                else localStorage.removeItem(TOKEN_KEY);
                if (!absPath) {
                    const picked = await doPickWorkspace();
                    if (!picked) return;
                }
                dsSetStatus('working', '连接本地服务...');
                try {
                    const resp = await agentFetch('/workspace', {}, 8000);
                    if (!resp.ok) throw new Error('HTTP ' + resp.status);
                    const data = await resp.json();
                    if (!data.cwd) throw new Error('后端返回为空');
                    absPath = data.cwd;
                } catch (e) {
                    log('无法连接本地服务: ' + e.message);
                    dsSetStatus('none', '连接失败');
                    return;
                }
                workspacePathEl.textContent = absPath;
                step = 2;
                goalContainer.style.display = 'flex';
                goalInput.focus();
                connectBtn.textContent = '启动对话';
                dsSetStatus('working', '输入目标');
                return;
            }
            if (step === 2) {
                let goal = goalInput.value.trim();
                const isGoalEmpty = !goal;
                if (isGoalEmpty) {
                    goal = '未指定（请自主探索当前工作区，根据观察到的文件结构，自行推测并决定你能提供的任务目标）';
                }
                const startModeEl = document.querySelector('input[name="ds-start-mode"]:checked');
                const startMode = startModeEl ? startModeEl.value : 'new';

                step = 3; isModeOn = true; lastGoal = goal;
                addRecentWorkspace(absPath);
                saveState();
                setupContainer.style.display = 'none';
                mainContainer.style.display = 'flex';
                dsSetStatus('active', '已连接');
                await fetchServerPlugins();
                log(`已连接，工作区: ${absPath}`);
                msgStore.clear();
        toolcallStatusMap.clear();
                currentChatUrl = location.href;

                const herePrompt = getInitPrompt(absPath, goal);
                const skipPromptEl = document.getElementById('ds-skip-prompt');
                const skipPrompt = !!(skipPromptEl && skipPromptEl.checked);

                if (startMode === 'here') {
                    log('启动方式: 当前对话内开始');
                    // 快照：启动时页面上已存在的消息，其工具调用一律不再执行（防刷新后重跑历史）
                    ignoreKeys.clear();
                    pickAll(SEL.virtualItem).forEach(el => {
                        const k = el.getAttribute('data-virtual-list-item-key');
                        if (k) ignoreKeys.add(k);
                    });
                    const primed = primeHistoryToolcalls();
                    if (primed) log(`已跳过当前对话中 ${primed} 个历史工具调用（防止重复执行）`);
                    if (skipPrompt) {
                        log('已选择不发送系统提示词，直接在当前对话继续监听');
                        startObserver();
                    } else {
                        setTimeout(async () => {
                            const r = await sendMessage(herePrompt);
                            if (!r.ok) log(`启动消息发送失败: ${r.reason}`);
                            else log('启动消息已发送');
                            startObserver();
                        }, 300);
                    }
                } else {
                    log('启动方式: 新对话开始');
                    ignoreKeys.clear();
                    const newChatBtnClick = Array.from(document.querySelectorAll('span'))
                        .find(el => el.textContent.trim() === '开启新对话')?.closest('[tabindex="0"]');
                    if (newChatBtnClick) {
                        newChatBtnClick.click();
                        setTimeout(async () => {
                            const r = await sendMessage(getInitPrompt(absPath, goal));
                            if (!r.ok) log(`初始化消息发送失败: ${r.reason}`);
                            startObserver();
                        }, 1000);
                    } else {
                        log('未找到新对话按钮，改为在当前对话开始');
                        ignoreKeys.clear();
                        pickAll(SEL.virtualItem).forEach(el => {
                            const k = el.getAttribute('data-virtual-list-item-key');
                            if (k) ignoreKeys.add(k);
                        });
                        primeHistoryToolcalls();
                        setTimeout(async () => {
                            const r = await sendMessage(herePrompt);
                            if (!r.ok) log(`启动消息发送失败: ${r.reason}`);
                            startObserver();
                        }, 300);
                    }
                }
                return;
            }
        });

        disconnectBtn.addEventListener('click', () => {
            step = 0; isModeOn = false;
            isProcessing = false; isCooldown = false; isCompressing = false; autoMode = false;
            processingStart = 0;
            if (cooldownTimer) { clearTimeout(cooldownTimer); cooldownTimer = null; }
            msgStore.clear();
        toolcallStatusMap.clear();
            pendingResults = null;
            interjectQueue.length = 0;
            ignoreKeys.clear();
            try { renderInterjectPending(); } catch {}
            if (observer) { observer.disconnect(); observer = null; }
            if (pollInterval) { clearInterval(pollInterval); pollInterval = null; }
            clearTimeout(observeTimeout);
            autoToggle.checked = false;
            throttleToggle.checked = true;
            autoThrottle = true;
            dsSetStatus('none', '已断开');
            setupContainer.style.display = 'flex';
            mainContainer.style.display = 'none';
            connectBtn.textContent = '开启模式';
            absContainer.style.display = 'none';
            goalContainer.style.display = 'none';
            isPaused = false;
            try { localStorage.removeItem(STATE_KEY); } catch {}
        });

        // ===== 状态恢复：刷新后自动填回上次的工作区/Token/开关（不自动连接）=====
        try {
            const st = loadState();
            if (st) {
                if (st.absPath) { absPath = st.absPath; workspacePathEl.textContent = st.absPath; workspacePathEl.title = st.absPath; }
                if (st.lastGoal) goalInput.value = st.lastGoal;
                autoToggle.checked = !!st.autoMode;
                throttleToggle.checked = st.autoThrottle !== false;
                autoMode = !!st.autoMode;
                autoThrottle = st.autoThrottle !== false;
                log('已恢复上次的配置（工作区/目标/开关），点击"开启模式"继续');
            }
            refreshRecentSelect();
        } catch {}

        return true;
    }

    function injectCompressBtn() {
        if (document.getElementById('ds-compress-btn-wrapper')) return;
        const sendBtn = pick(SEL.sendBtn);
        if (!sendBtn) return;
        const toolbar = pick(SEL.toolbar) || sendBtn.closest('div')?.parentElement;
        if (!toolbar) return;
        toolbar.style.cssText = 'display:flex;flex-direction:row;align-items:center;gap:10px;';

        const wrapper = document.createElement('div');
        wrapper.id = 'ds-compress-btn-wrapper';
        const btn = document.createElement('button');
        btn.className = 'ds-compress-btn';
        btn.innerHTML = `${I.arrow}<span>压缩并转移</span>`;

        btn.addEventListener('click', async () => {
            if (!isModeOn) return alert('请先开启本地互联模式');
            if (btn.disabled) return;
            btn.disabled = true;
            btn.innerHTML = `${I.spinner}<span>压缩中...</span>`;
            isCompressing = true;
            try {
                const prompt = `【系统指令：上下文压缩】\n请将我们之前的所有对话、代码逻辑、工作进度进行提炼。用 Markdown 格式输出一份详尽的状态摘要，包含：\n1. 当前工作绝对路径\n2. 核心文件用途及关键代码\n3. 已完成/未完成任务\n4. 下一步建议操作\n请直接输出摘要。`;
                const r = await sendMessage(prompt);
                if (!r.ok) { alert('发送失败: ' + r.reason); return; }
                await waitForAIResponse();
                const item = getLatestAssistantItem();
                if (!item) return;
                const c = pick(SEL.assistantContent, item);
                const summary = c ? (c.innerText || '') : '';
                const newChatBtn = Array.from(document.querySelectorAll('span'))
                    .find(el => el.textContent.trim() === '开启新对话')?.closest('[tabindex="0"]');
                if (newChatBtn) {
                    newChatBtn.click();
                    setTimeout(async () => {
                        msgStore.clear();
        toolcallStatusMap.clear();
                        currentChatUrl = location.href;
                        await sendMessage(getInitPrompt(absPath, "【前情提要：历史对话压缩摘要】\n" + summary + "\n\n请阅读上述摘要，了解工作进度。接下来请告诉我你想从哪里继续？"));
                    }, 1500);
                }
            } finally {
                btn.disabled = false;
                btn.innerHTML = `${I.arrow}<span>压缩并转移</span>`;
                isCompressing = false;
            }
        });

        wrapper.appendChild(btn);
        const sendWrapper = sendBtn.closest('div[style="width: fit-content;"]') || sendBtn;
        toolbar.insertBefore(wrapper, sendWrapper);
    }

    // ===== 插件 UI 挂载系统 =====
    // 插件可注册按钮/开关，挂在发送工具栏或思考/搜索开关旁
    // W.DS_UI_Slots.addButton({ id, label, icon, title, onClick, slot: 'toolbar'|'toggle' })
    // W.DS_UI_Slots.addToggle({ id, label, defaultOn, onChange, slot: 'toggle' })
    W.DS_UI_Slots = W.DS_UI_Slots || (function () {
        const buttons = [];   // { id, label, icon, title, onClick, slot, el }
        const toggles = [];   // { id, label, defaultOn, onChange, state, el }
        function addButton(cfg) {
            if (!cfg || !cfg.id) throw new Error('addButton 需要 id');
            if (buttons.find(b => b.id === cfg.id)) return false;
            buttons.push(Object.assign({ slot: 'toolbar', label: '', icon: '', title: '' }, cfg));
            scheduleInject();
            return true;
        }
        function addToggle(cfg) {
            if (!cfg || !cfg.id) throw new Error('addToggle 需要 id');
            if (toggles.find(t => t.id === cfg.id)) return false;
            const saved = loadToggleState();
            const initState = (saved[cfg.id] !== undefined) ? !!saved[cfg.id] : !!cfg.defaultOn;
            toggles.push(Object.assign({ slot: 'toggle', label: '', defaultOn: false }, cfg, { state: initState }));
            scheduleInject();
            return true;
        }
        function removeItem(id) {
            let i = buttons.findIndex(b => b.id === id);
            if (i >= 0) { const b = buttons[i]; if (b.el && b.el.parentNode) b.el.remove(); buttons.splice(i, 1); return true; }
            i = toggles.findIndex(t => t.id === id);
            if (i >= 0) { const t = toggles[i]; if (t.el && t.el.parentNode) t.el.remove(); toggles.splice(i, 1); return true; }
            return false;
        }
        // 开关状态持久化
        const TOGGLE_STATE_KEY = 'ds_plugin_toggle_state';
        function loadToggleState() {
            try { return JSON.parse(localStorage.getItem(TOGGLE_STATE_KEY) || '{}') || {}; } catch { return {}; }
        }
        function persistToggle(id, state) {
            try {
                const all = loadToggleState();
                all[id] = !!state;
                localStorage.setItem(TOGGLE_STATE_KEY, JSON.stringify(all));
            } catch {}
        }
        function setToggle(id, state) {
            const t = toggles.find(x => x.id === id);
            if (!t) return false;
            t.state = !!state;
            persistToggle(id, t.state);
            if (t.el) {
                // 触发一次视觉更新：直接重绘样式
                const chip = t.el;
                const dot = chip.querySelector('span');
                if (t.state) {
                    chip.style.borderColor = 'rgba(57,100,254,0.5)';
                    chip.style.color = 'var(--dsw-alias-label-primary,#f9fafb)';
                    if (dot) dot.style.background = 'var(--dsw-alias-brand-primary,#3964fe)';
                } else {
                    chip.style.borderColor = 'rgba(255,255,255,0.12)';
                    chip.style.color = 'var(--dsw-alias-label-tertiary,#81858c)';
                    if (dot) dot.style.background = '#61666b';
                }
            }
            try { t.onChange && t.onChange(t.state); } catch (e) { showToast('error', '插件开关出错: ' + e.message, 4000); }
            return true;
        }
        function list() {
            return {
                buttons: buttons.map(b => ({ id: b.id, label: b.label, slot: b.slot })),
                toggles: toggles.map(t => ({ id: t.id, label: t.label, state: t.state })),
            };
        }
        let _scheduled = false;
        function scheduleInject() {
            if (_scheduled) return;
            _scheduled = true;
            setTimeout(() => { _scheduled = false; try { injectPluginUI(); } catch (e) { log('插件UI注入异常: ' + e.message); } }, 100);
        }
        return { addButton, addToggle, removeItem, setToggle, list, buttons, toggles, _loadToggleState: loadToggleState, _persistToggle: persistToggle, _scheduleInject: scheduleInject };
    })();

    function injectPluginUI() {
        if (!W.DS_UI_Slots) return;
        // 1. 工具栏按钮（发送按钮旁）
        const sendBtn = pick(SEL.sendBtn);
        if (sendBtn) {
            const toolbar = pick(SEL.toolbar) || sendBtn.closest('div')?.parentElement;
            if (toolbar) {
                let host = document.getElementById('ds-plugin-toolbar-host');
                if (!host) {
                    host = document.createElement('div');
                    host.id = 'ds-plugin-toolbar-host';
                    host.style.cssText = 'display:flex;align-items:center;gap:6px;';
                    const sendWrapper = sendBtn.closest('div[style="width: fit-content;"]') || sendBtn;
                    toolbar.insertBefore(host, sendWrapper);
                }
                W.DS_UI_Slots.buttons.forEach(b => {
                    if (b.slot !== 'toolbar') return;
                    if (b.el && b.el.parentNode) return;
                    const btn = document.createElement('button');
                    btn.className = 'ds-compress-btn';
                    btn.style.cssText = 'height:34px;font-size:13px;';
                    if (b.title) btn.title = b.title;
                    btn.innerHTML = (b.icon || '') + (b.label ? '<span>' + esc(b.label) + '</span>' : '');
                    btn.addEventListener('click', () => {
                        try { Promise.resolve(b.onClick && b.onClick(btn)).catch(e => showToast('error', '插件按钮出错: ' + e.message, 4000)); }
                        catch (e) { showToast('error', '插件按钮出错: ' + e.message, 4000); }
                    });
                    host.appendChild(btn);
                    b.el = btn;
                });
            }
        }
        // 2. 开关（深度思考/智能搜索旁边）
        const toggleToggles = document.querySelectorAll('.ds-toggle-button');
        if (toggleToggles.length) {
            const bar = toggleToggles[0].parentElement; // _58b31c9
            if (bar) {
                let host = document.getElementById('ds-plugin-toggle-host');
                if (!host) {
                    host = document.createElement('div');
                    host.id = 'ds-plugin-toggle-host';
                    host.style.cssText = 'display:inline-flex;align-items:center;gap:6px;margin-left:6px;';
                    bar.appendChild(host);
                }
                W.DS_UI_Slots.toggles.forEach(t => {
                    if (t.slot !== 'toggle') return;
                    if (t.el && t.el.parentNode) return;
                    const chip = document.createElement('div');
                    chip.className = 'ds-toggle-button ds-plugin-toggle' + (t.state ? ' ds-plugin-toggle-on' : '');
                    chip.style.cssText = 'display:inline-flex;align-items:center;gap:6px;height:28px;padding:0 12px;border-radius:4096px;cursor:pointer;font-size:12px;border:1px solid rgba(255,255,255,0.12);color:var(--dsw-alias-label-tertiary,#81858c);transition:all .15s;user-select:none;';
                    const dot = document.createElement('span');
                    dot.style.cssText = 'width:8px;height:8px;border-radius:50%;background:#61666b;transition:background .15s;';
                    chip.appendChild(dot);
                    if (t.label) { const sp = document.createElement('span'); sp.textContent = t.label; chip.appendChild(sp); }
                    const applyStyle = () => {
                        if (t.state) {
                            chip.style.borderColor = 'rgba(57,100,254,0.5)';
                            chip.style.color = 'var(--dsw-alias-label-primary,#f9fafb)';
                            dot.style.background = 'var(--dsw-alias-brand-primary,#3964fe)';
                        } else {
                            chip.style.borderColor = 'rgba(255,255,255,0.12)';
                            chip.style.color = 'var(--dsw-alias-label-tertiary,#81858c)';
                            dot.style.background = '#61666b';
                        }
                    };
                    applyStyle();
                    chip.addEventListener('click', () => {
                        t.state = !t.state;
                        applyStyle();
                        try { W.DS_UI_Slots._persistToggle(t.id, t.state); } catch (e) {}
                        try { t.onChange && t.onChange(t.state); } catch (e) { showToast('error', '插件开关出错: ' + e.message, 4000); }
                    });
                    host.appendChild(chip);
                    t.el = chip;
                });
            }
        }
    }

    function waitForAIResponse(maxWait = 180000) {
        return new Promise(resolve => {
            const start = Date.now();
            let lastLen = -1, unchanged = 0;
            const POLL_MS = 500, NEED = 5;
            const iv = setInterval(() => {
                if (Date.now() - start > maxWait) { clearInterval(iv); resolve(); return; }
                const item = getLatestAssistantItem();
                if (!item) return;
                const len = getContentLength(item);
                if (len > 0 && len === lastLen) {
                    if (++unchanged >= NEED) { clearInterval(iv); resolve(); }
                } else { unchanged = 0; lastLen = len; }
            }, POLL_MS);
        });
    }

    setInterval(() => {
        if (findNewChatButton()) {
            injectUI();
            injectCompressBtn();
            try { injectPluginUI(); } catch (e) {}
        }
    }, 1000);

    // 未开启互联模式时，也扫描并折叠页面上已加载的对话内容（只做展示，不执行任何工具）
    setInterval(() => {
        if (isModeOn) return;
        try { hideToolResultMessages(); } catch (e) {}
        try { foldAllToolcalls(); } catch (e) {}
    }, 2000);

})();