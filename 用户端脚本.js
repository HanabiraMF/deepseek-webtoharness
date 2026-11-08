// ==UserScript==
// @name         DeepSeek 本地互联
// @namespace    http://tampermonkey.net/
// @version      1.9
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
    };

    let dirHandle = null, tempDirHandle = null;
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

    const TOKEN_KEY = 'ds_agent_token';
    let agentToken = localStorage.getItem(TOKEN_KEY) || '';

    let pendingResults = null;
    let pendingRetries = 0;
    let pendingLastTry = 0;
    const PENDING_MAX_RETRIES = 3;
    const toolcallStatusMap = new Map(); // sig -> 'running' | 'success' | 'error' | 'queue'
    const PROCESS_TIMEOUT = 30 * 1000;

    // ===== 消息状态存储：key = data-virtual-list-item-key =====
    const msgStore = new Map(); // key -> { len, lastChange, done, sigs }
    // 已执行签名按消息 key 持久化：msgStore 回收条目后，滚动回来也不会重复执行
    const executedByKey = new Map(); // key -> Set(sig)
    const MSG_STORE_MAX = 60;
    const DONE_QUIET_MS = 1000;        // 纯静默判定：字数 1 秒内不再增加才判定结束

    const SEL = {
        virtualItem:      ['[data-virtual-list-item-key]'],
        message:          ['.ds-message'],
        assistantContent: ['.ds-assistant-message-main-content', '[class*="assistant-message-main"]'],
        thinkContent:     ['.ds-think-content'],
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

    const styleEl = document.createElement('style');
    styleEl.textContent = `
        .ds-svg { display: inline-block; vertical-align: middle; flex-shrink: 0; }
        .ds-spin { animation: ds-spin 0.8s linear infinite; }
        @keyframes ds-spin { to { transform: rotate(360deg); } }
        @keyframes ds-pulse { 0% { opacity: 1; } 50% { opacity: 0.4; } 100% { opacity: 1; } }
        @keyframes ds-fadein { to { opacity: 1; } }
        @keyframes ds-slideup { to { transform: translateY(0); } }
        .ds-panel-container { margin: 8px 12px; padding: 12px; background: var(--dsw-alias-bg-layer-2, #2b2b2b); border-radius: 12px; font-size: 13px; color: var(--dsw-alias-text-primary, #ddd); display: flex; flex-direction: column; gap: 10px; border: 1px solid var(--dsw-alias-border-subtle, rgba(255,255,255,0.1)); box-shadow: 0 4px 12px rgba(0,0,0,0.1); }
        .ds-status-dot { width: 8px; height: 8px; border-radius: 50%; background: #aaa; display: inline-block; margin-right: 6px; flex-shrink: 0; }
        .ds-status-dot.active { background: #4CAF50; box-shadow: 0 0 8px #4CAF50; animation: ds-pulse 2s infinite; }
        .ds-status-dot.working { background: #eab308; box-shadow: 0 0 8px #eab308; animation: ds-pulse 1s infinite; }
        .ds-btn { padding: 8px 12px; border-radius: 6px; border: none; font-weight: 600; cursor: pointer; transition: opacity 0.2s; font-size: 13px; display: inline-flex; align-items: center; justify-content: center; gap: 6px; font-family: inherit; }
        .ds-btn:hover { opacity: 0.85; }
        .ds-btn:disabled { opacity: 0.5; cursor: not-allowed; }
        .ds-btn-primary { background: var(--dsw-alias-brand-primary, #4CAF50); color: #fff; }
        .ds-btn-danger { background: var(--dsw-alias-state-error-primary, #d32f2f); color: #fff; }
        .ds-btn-secondary { background: var(--dsw-alias-bg-layer-1, #333); color: var(--dsw-alias-text-primary, #ddd); border: 1px solid var(--dsw-alias-border-subtle, #444); }
        .ds-input { padding: 6px 10px; background: var(--dsw-alias-bg-layer-1, #000); border: 1px solid var(--dsw-alias-border-subtle, #444); color: var(--dsw-alias-text-primary, #fff); border-radius: 6px; font-size: 12px; outline: none; width: 100%; box-sizing: border-box; font-family: inherit; }
        .ds-input:focus { border-color: var(--dsw-alias-brand-primary, #4CAF50); }
        .ds-log-area { max-height: 200px; overflow-y: auto; font-size: 11px; color: #888; font-family: ui-monospace, monospace; background: rgba(0,0,0,0.2); padding: 6px; border-radius: 6px; line-height: 1.5; white-space: pre-wrap; }
        .ds-log-area > div { margin-bottom: 2px; }
        .ds-log-area .err { color: #f87171; }
        .ds-log-area .ok { color: #4ade80; }
        .ds-overlay { position: fixed; inset: 0; background: rgba(0,0,0,0.6); backdrop-filter: blur(4px); z-index: 99999; display: flex; align-items: center; justify-content: center; opacity: 0; animation: ds-fadein 0.2s forwards; }
        .ds-dialog { background: var(--dsw-alias-bg-layer-2, #1e1e1e); color: #fff; border-radius: 12px; padding: 24px; box-shadow: 0 10px 40px rgba(0,0,0,0.5); border: 1px solid #333; display: flex; flex-direction: column; gap: 14px; transform: translateY(10px); animation: ds-slideup 0.3s forwards; max-height: 85vh; overflow-y: auto; }
        .ds-compress-btn { display: inline-flex; align-items: center; justify-content: center; height: 34px; padding: 0 14px; border-radius: 17px; background: #4CAF50; color: #fff; border: none; cursor: pointer; transition: all 0.2s; white-space: nowrap; box-shadow: 0 2px 6px rgba(76,175,80,0.3); font-size: 13px; font-weight: 600; gap: 6px; font-family: inherit; }
        .ds-compress-btn:hover { background: #43a047; }
        .ds-compress-btn:disabled { opacity: 0.5; cursor: not-allowed; }
        /* ===== 通用折叠列表 ===== */
        .ds-fold-list { display: flex; flex-direction: column; gap: 6px; margin: 8px 0; }
        .ds-fold-item { display: flex; flex-direction: column; }
        .ds-fold-row { display: flex; align-items: center; gap: 6px; padding: 6px 10px; background: var(--dsw-alias-bg-layer-2, #2b2b2b); border: 1px solid var(--dsw-alias-border-subtle, rgba(255,255,255,0.1)); border-radius: 6px; cursor: pointer; font-size: 12px; color: #ccc; font-family: ui-monospace, monospace; user-select: none; }
        .ds-fold-row:hover { border-color: var(--dsw-alias-brand-primary, #4CAF50); }
        .ds-fold-row .ds-fold-arrow { display: inline-flex; color: #4CAF50; transition: transform 0.15s; }
        .ds-fold-row .ds-fold-label { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
        .ds-fold-detail { display: none; margin: 4px 0 0; padding: 8px; background: #000; border-radius: 6px; font-size: 11px; color: #4ade80; white-space: pre-wrap; word-break: break-all; font-family: ui-monospace, monospace; overflow: auto; max-height: 300px; }
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

你是本地代码智能体。工作流程：思考 → 调用工具 → 等待结果 → 下一步。

【核心规则】
1. 【第一铁律】必须使用代码块！每一次工具调用，必须把完整的 <toolcall> 包裹在 \`\`\`toolcall 代码块中。绝对禁止直接输出裸 XML。如果你不包代码块，系统将无法解析。
2. 绝对真实：任何目录、文件内容必须通过工具获取，严禁编造。
3. 先读后写：修改文件前，必须先 openfile 读取内容，再 edit。禁止盲改。
3. 备份机制：系统在 writefile 和 edit 前，会自动将原文件另存为 .bak 备份，故可放心执行，但需注意目录整洁。
4. 批量执行：多个无依赖的操作（如连续读多个文件、执行多个命令），请一次性输出多个 toolcall 代码块，系统会按顺序执行并统一返回。
5. 严谨传参：路径用相对路径；含特殊字符时必须用 <![CDATA[...]]> 包裹；edit 的 old 必须与文件绝对一致且唯一。
6. 失败自省：收到 [失败]，仔细看原因，修正后重试。遇到执行命令无输出，务必检查退出码。
7. 【禁区】严禁删除、覆写或破坏 server.js 和 plugins/ 目录（包括其中任何插件文件）。它们承载着本地互联的基础设施，除非用户在当前对话中明确要求删除，否则一律不得触碰。

【工作区信息】
绝对路径：${absPath}
当前目标：${taskGoal}

【输出格式强制要求】
发起任何操作，必须严格遵循以下包裹格式，否则调用会失败！

正确格式：
\`\`\`toolcall
<toolcall>
  <op>工具名</op>
  <参数>值</参数>
</toolcall>
\`\`\`

【工具字典】
- listdir: <path>目录</path> (列出目录)
- openfile: <path>文件</path> (读文件)
- mkdir: <path>目录</path> (创建空目录)
- edit: <path>文件</path><old><![CDATA[原]]></old><new><![CDATA[新]]></new> (精准替换)
- editline: <path>文件</path><line>行号</line><mode>replace|insert|delete</mode><content><![CDATA[...]]></content> (按行号编辑)
- writefile: <path>文件</path><content><![CDATA[...]]></content> (整文件覆写)
- append: <path>文件</path><content><![CDATA[...]]></content> (末尾追加)
- replaceall: <find><![CDATA[找]]></find><replace><![CDATA[替换为]]></replace><path>目录或文件</path> (跨文件批量替换)
- grep: <pattern>正则</pattern><path>目录</path> (正则搜索)
- glob: <pattern>**/*.js</pattern> (通配符搜文件)
- del: <path>目标</path> (删除)
- move: <from>源</from><to>目标</to> (移动/重命名)
- copy: <from>源</from><to>目标</to> (复制)
- stat: <path>目标</path> (查看信息)
- diff: <path1>文件1</path1><path2>文件2</path2> (对比两文件)
- hash: <path>文件</path> (计算SHA-256)
- exec: <command>命令</command><cwd>可选</cwd><timeout>可选毫秒</timeout> (自动执行命令，静默返回 stdout/stderr 和退出码)
- runcmd: <command>命令</command><reason>理由</reason> (需用户弹窗确认执行)
- waitfile: <path>文件</path><timeout>毫秒</timeout> (轮询等待文件生成)
- ask: <question>问题</question><options><option>A</option><option>B</option></options> (询问用户)
- preview: <path>路径</path> (预览网页/文档)
- openurl: <url>地址</url> (打开网页)
- fetch: <url>地址</url><method>GET</method><headers><![CDATA[{"Key":"Val"}]]></headers><content><![CDATA[...]]></content> (HTTP请求)
- image: <path>图片</path> (展示图片)
- clipboard: <text>文本</text> (复制到剪贴板)
- chmod: <path>文件</path><mode>755</mode> (修改权限；类 Unix 用 chmod 语法，Windows 用 +R/-R 走 attrib)
- sleep: <timeout>1000</timeout> (休眠指定毫秒，最大 5 分钟；用于轮询间隔或等待外部进程)
- gettime: (获取当前时间)
- register_plugin: <plugin_name>工具名</plugin_name><plugin_js><![CDATA[(返回对象的 JS 代码)]]></plugin_js> (注册一个【前端】自定义工具，当前页面内存生效)
- reload_server_plugins: (无参数) (如果你用 writefile 往 plugins/xxx.js 写了 Node.js 插件，调用此工具热加载它)
- kill_process: <pid>进程ID</pid> (强制终止后台运行的程序。如果 exec 超时返回了 PID，且你觉得它卡死了，用它杀掉)

【关于长驻命令】
如果你执行了耗时超过 30 秒的命令（如启动服务器、长循环等），exec 会返回当前的输出和进程 PID，并让它转入后台运行。如果你觉得不需要它了或者卡死了，请调用 kill_process 终结它。

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
如果你需要访问本地文件、数据库、没有跨域限制的网络请求等，可以用 writefile 将 Node.js 代码写到 'plugins/xxx.js'，然后调用 'reload_server_plugins' 热加载！
服务端插件模板 (plugins/xxx.js)：
module.exports = {
    name: 'my_node_tool',
    description: '服务端 Node.js 工具',
    execute: async (args) => {
        // 可以在这里使用 require('fs'), require('child_process') 等
        return '结果';
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

    function parsePath(raw) {
        let p = (raw || '.').trim().replace(/^[`'"“”\s]+|[`'"“”\s]+$/g, '');
        if (!p) p = '.';
        p = p.replace(/\\/g, '/');
        if (absPath) {
            const norm = absPath.replace(/\\/g, '/').toLowerCase();
            if (p.toLowerCase().startsWith(norm)) p = p.substring(absPath.length);
        }
        p = p.replace(/^[a-zA-Z]:/, '');
        if (p === '/' || p === '.') return [];
        const parts = p.split('/').filter(x => x && x !== '.');
        if (parts.some(x => x === '..')) throw new Error('不允许越权访问（路径含 ..）');
        return parts.map(x => x.replace(/[<>:"|?*\n\r\t]/g, '').trim()).filter(Boolean);
    }

    async function getFileHandle(path, create = false) {
        const parts = parsePath(path);
        if (!parts.length) throw new Error('根目录不能作为文件');
        let cur = dirHandle;
        for (let i = 0; i < parts.length - 1; i++) cur = await cur.getDirectoryHandle(parts[i], { create });
        return cur.getFileHandle(parts[parts.length - 1], { create });
    }

    async function getDirHandle(path, create = false) {
        let cur = dirHandle;
        for (const part of parsePath(path)) cur = await cur.getDirectoryHandle(part, { create });
        return cur;
    }

    async function readFile(path, maxSize = 2 * 1024 * 1024) {
        const file = await (await getFileHandle(path)).getFile();
        if (file.size > maxSize) throw new Error(`文件过大 (${(file.size/1024/1024).toFixed(1)}MB)，请用 grep 或分段读取`);
        return file.text();
    }

    async function writeFile(path, content) {
        const fh = await getFileHandle(path, true);
        const w = await fh.createWritable();
        await w.write(content);
        await w.close();
        return `${path} 写入成功 (${content.length} 字符)`;
    }

    async function readFileBinary(path, maxSize = 100 * 1024 * 1024) {
        const file = await (await getFileHandle(path)).getFile();
        if (file.size > maxSize) throw new Error(`文件过大 (${(file.size/1024/1024).toFixed(1)}MB)，超过上限`);
        return file.arrayBuffer();
    }

    async function writeFileBinary(path, buffer) {
        const fh = await getFileHandle(path, true);
        const w = await fh.createWritable();
        await w.write(buffer);
        await w.close();
    }

    async function pathInfo(path) {
        const parts = parsePath(path);
        if (!parts.length) return { type: 'dir' };
        let cur = dirHandle;
        try {
            for (let i = 0; i < parts.length - 1; i++) cur = await cur.getDirectoryHandle(parts[i]);
            const name = parts[parts.length - 1];
            try { await cur.getFileHandle(name); return { type: 'file' }; } catch {}
            try { await cur.getDirectoryHandle(name); return { type: 'dir' }; } catch {}
            return null;
        } catch { return null; }
    }

    async function deletePath(path, recursive) {
        const parts = parsePath(path);
        if (!parts.length) throw new Error('不能删除根目录');
        let cur = dirHandle;
        for (let i = 0; i < parts.length - 1; i++) cur = await cur.getDirectoryHandle(parts[i]);
        await cur.removeEntry(parts[parts.length - 1], { recursive: !!recursive });
        return `已删除: ${path}`;
    }

    async function listDir(path) {
        const cur = await getDirHandle(path);
        const out = [];
        for await (const e of cur.values()) out.push(`${e.kind === 'file' ? 'f' : 'd'} ${e.name}`);
        return out.length ? out.join('\n') : '(空目录)';
    }

    async function workspaceSnapshot(limit = 30) {
        try {
            const items = [];
            for await (const e of dirHandle.values()) {
                items.push(`${e.kind === 'file' ? 'f' : 'd'} ${e.name}`);
                if (items.length >= limit) { items.push('…'); break; }
            }
            return items.length ? items.join(', ') : '(空)';
        } catch { return '(无法读取)'; }
    }

    async function resolveTarget(from, to) {
        let target = to, isDir = false;
        if (/[\/\\]$/.test(to)) isDir = true;
        else { const info = await pathInfo(to); if (info?.type === 'dir') isDir = true; }
        if (isDir) target = to.replace(/[\/\\]+$/, '') + '/' + parsePath(from).pop();
        return target;
    }

    async function copyDirInto(srcDir, dstDir) {
        for await (const entry of srcDir.values()) {
            if (entry.kind === 'file') {
                const data = await (await entry.getFile()).arrayBuffer();
                const fh = await dstDir.getFileHandle(entry.name, { create: true });
                const w = await fh.createWritable();
                await w.write(data);
                await w.close();
            } else {
                const sub = await dstDir.getDirectoryHandle(entry.name, { create: true });
                await copyDirInto(entry, sub);
            }
        }
    }

    const SKIP_DIRS = new Set(['.git','node_modules','dist','build','venv','.venv','__pycache__','target','.next','out','.idea','.vscode','obj','bin','debug','release']);
    const SKIP_EXTS = new Set(['.png','.jpg','.jpeg','.gif','.ico','.exe','.dll','.so','.dylib','.bin','.pdf','.zip','.tar','.gz','.7z','.resources','.baml','.cache','.pyc','.obj','.pdb','.mp4','.mp3','.woff','.woff2','.ttf']);
    const MAX_FILE = 500 * 1024, MAX_DEPTH = 8, MAX_RESULTS = 200;

    function isBinary(text) {
        const s = text.slice(0, 1000);
        if (s.includes('\0')) return true;
        let n = 0;
        for (let i = 0; i < s.length; i++) { const c = s.charCodeAt(i); if (c < 9 || (c > 13 && c < 32)) n++; }
        return n / Math.max(1, s.length) > 0.1;
    }

    async function grep(pattern, rootPath = '.') {
        let re;
        try { re = new RegExp(pattern, 'i'); } catch (e) { throw new Error(`正则无效: ${e.message}`); }
        const fileInfo = await pathInfo(rootPath).catch(() => null);
        if (fileInfo && fileInfo.type === 'file') {
            const results0 = [];
            const text = await readFile(rootPath, MAX_FILE);
            if (!isBinary(text)) {
                text.split('\n').forEach((line, i) => {
                    if (results0.length >= MAX_RESULTS) return;
                    if (re.test(line)) results0.push(`${rootPath}:${i + 1}: ${line.trim().slice(0, 200)}`);
                });
            }
            const suffix0 = results0.length >= MAX_RESULTS ? '\n...(已达上限，请缩小范围)' : '';
            return results0.length ? results0.join('\n') + suffix0 : '(无匹配)';
        }
        const root = await getDirHandle(rootPath);
        const results = [];
        async function walk(dir, prefix, depth) {
            if (depth > MAX_DEPTH || results.length >= MAX_RESULTS) return;
            for await (const entry of dir.values()) {
                if (results.length >= MAX_RESULTS) return;
                const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
                if (entry.kind === 'directory') {
                    if (SKIP_DIRS.has(entry.name.toLowerCase())) continue;
                    await walk(entry, rel, depth + 1);
                } else {
                    const ext = '.' + entry.name.split('.').pop().toLowerCase();
                    if (SKIP_EXTS.has(ext)) continue;
                    try {
                        const f = await entry.getFile();
                        if (f.size > MAX_FILE) continue;
                        const text = await f.text();
                        if (isBinary(text)) continue;
                        text.split('\n').forEach((line, i) => {
                            if (results.length >= MAX_RESULTS) return;
                            if (re.test(line)) results.push(`${rel}:${i+1}: ${line.trim().slice(0,200)}`);
                        });
                    } catch {}
                }
            }
        }
        await walk(root, '', 0);
        const suffix = results.length >= MAX_RESULTS ? '\n...(已达上限，请缩小范围)' : '';
        return results.length ? results.join('\n') + suffix : '(无匹配)';
    }

    function globToRegex(pattern) {
        const parts = pattern.replace(/\\/g, '/').split('/');
        let re = '';
        for (let i = 0; i < parts.length; i++) {
            const seg = parts[i];
            if (seg === '**') re += (i === parts.length - 1) ? '.*' : '(?:.*\\/)?';
            else {
                re += seg.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]');
                if (i < parts.length - 1) re += '\\/';
            }
        }
        return new RegExp('^' + re + '$');
    }

    async function glob(pattern) {
        const re = globToRegex(pattern);
        const results = [];
        async function walk(dir, prefix, depth) {
            if (depth > MAX_DEPTH || results.length >= MAX_RESULTS) return;
            for await (const entry of dir.values()) {
                if (results.length >= MAX_RESULTS) return;
                const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
                if (entry.kind === 'directory') {
                    if (SKIP_DIRS.has(entry.name.toLowerCase())) continue;
                    await walk(entry, rel, depth + 1);
                } else if (re.test(rel)) results.push(rel);
            }
        }
        await walk(dirHandle, '', 0);
        const suffix = results.length >= MAX_RESULTS ? '\n...(已达上限)' : '';
        return results.length ? results.join('\n') + suffix : '(无匹配)';
    }

    function showConfirmDialog(title, target, reason, extraHtml = '') {
        return new Promise(resolve => {
            const o = document.createElement('div');
            o.className = 'ds-overlay';
            const reasonHtml = reason ? `<div style="background:rgba(255,183,77,0.1);padding:10px;border-radius:6px;font-size:12px;color:#ffb74d;border-left:3px solid #ffb74d;display:flex;align-items:flex-start;gap:6px;"><span style="color:#ffb74d;display:flex;margin-top:1px;">${I.warning}</span><span>${esc(reason)}</span></div>` : '';
            o.innerHTML = `
                <div class="ds-dialog" style="width:${extraHtml ? '720px' : '440px'};">
                    <h3 style="margin:0;font-size:15px;display:flex;align-items:center;gap:8px;color:#ffb74d;">${I.warning}<span>${esc(title)}</span></h3>
                    <div style="font-size:13px;">目标：<strong style="color:#4CAF50;word-break:break-all;">${esc(target)}</strong></div>
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

    function showCmdDialog(cmd, reason) {
        return new Promise(resolve => {
            const o = document.createElement('div');
            o.className = 'ds-overlay';
            const reasonHtml = reason ? `<div style="background:rgba(255,183,77,0.1);padding:10px;border-radius:6px;font-size:12px;color:#ffb74d;border-left:3px solid #ffb74d;display:flex;align-items:flex-start;gap:6px;"><span style="color:#ffb74d;display:flex;margin-top:1px;">${I.warning}</span><span>${esc(reason)}</span></div>` : '';
            o.innerHTML = `
                <div class="ds-dialog" style="width:640px;">
                    <h3 style="margin:0;font-size:15px;display:flex;align-items:center;gap:8px;color:#ffb74d;">${I.warning}<span>AI 请求执行命令</span></h3>
                    ${reasonHtml}
                    <div style="background:#000;padding:12px;border-radius:6px;font-family:ui-monospace,monospace;font-size:13px;word-break:break-all;border:1px solid #444;user-select:all;color:#4ade80;">${esc(cmd)}</div>
                    <button class="ds-btn ds-btn-primary" id="cmd-copy" style="align-self:flex-start;">${I.copy}<span>复制命令</span></button>
                    <div style="font-size:12px;color:#888;">请在终端执行，把输出粘贴回下方（留空代表无输出）：</div>
                    <textarea id="cmd-output" class="ds-input" placeholder="粘贴执行输出" style="height:140px;font-family:ui-monospace,monospace;resize:vertical;"></textarea>
                    <div style="display:flex;justify-content:flex-end;gap:10px;">
                        <button class="ds-btn ds-btn-secondary" id="cmd-cancel">取消</button>
                        <button class="ds-btn ds-btn-primary" id="cmd-done">完成并回传</button>
                    </div>
                </div>`;
            document.body.appendChild(o);
            awaitingUser = true;
            o.querySelector('#cmd-copy').onclick = (e) => {
                navigator.clipboard.writeText(cmd);
                const b = e.currentTarget;
                const old = b.innerHTML;
                b.innerHTML = `${I.check}<span>已复制</span>`;
                setTimeout(() => { b.innerHTML = old; }, 1500);
            };
            o.querySelector('#cmd-cancel').onclick = () => { awaitingUser = false; o.remove(); resolve({ cancel: true }); };
            o.querySelector('#cmd-done').onclick = () => {
                const out = o.querySelector('#cmd-output').value;
                awaitingUser = false; o.remove(); resolve({ cancel: false, output: out });
            };
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
                    <h3 style="margin:0;font-size:15px;display:flex;align-items:center;gap:8px;color:#4CAF50;">${I.question}<span>AI 需要你做出选择</span></h3>
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
            if (!disabled) { btn.click(); return { ok: true }; }
            await sleep(100);
        }
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
        const pres = root.querySelectorAll('pre');
        pres.forEach(pre => {
            const text = pre.textContent || '';
            if (!text.includes('<toolcall>')) return;
            const sig = String(text.length) + '_' + hashStr(text);
            if (pre.getAttribute('data-ds-folded') === sig) return;

            const matches = text.match(/<toolcall>[\s\S]*?<\/toolcall>/g) || [];
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
                row.innerHTML = `<span class="ds-fold-arrow" style="color:${initialColor}" data-state="${status}">${initialIcon}</span><span class="ds-fold-label"><b>${esc(op)}</b> · ${esc(summary)}</span>`;

                const detail = document.createElement('div');
                detail.className = 'ds-fold-detail';
                detail.textContent = rawCall;

                row.addEventListener('click', () => {
                    const open = detail.style.display === 'block';
                    detail.style.display = open ? 'none' : 'block';
                    const arrow = row.querySelector('.ds-fold-arrow');
                    if (status === 'success' || status === 'error') {
                        // 保持状态图标不旋转
                    } else {
                        arrow.style.transform = open ? '' : 'rotate(90deg)';
                    }
                });

                item.appendChild(row);
                item.appendChild(detail);
                container.appendChild(item);
            });

            block.parentNode.insertBefore(container, block);
            block.style.display = 'none';
        });
    }

    function foldAllToolcalls() {
        if (!isModeOn) return;
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
            if (text.trim().startsWith('【系统执行结果】\n') || text.trim().startsWith('【系统提示：本地互联模式已开启')) {
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

                    row.innerHTML = `<span class="ds-fold-arrow" style="color:${color}">${icon}</span><span class="ds-fold-label"><b style="color:${color}">[${status}]</b> ${esc(opName)} · ${esc(pathInfo || '无路径')}</span>`;

                    const detail = document.createElement('div');
                    detail.className = 'ds-fold-detail';
                    detail.textContent = content;

                    row.addEventListener('click', () => {
                        const open = detail.style.display === 'block';
                        detail.style.display = open ? 'none' : 'block';
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
                    row.innerHTML = `<span class="ds-fold-arrow" style="color:#888">${I.circle}</span><span class="ds-fold-label"><b>${text.startsWith('【系统提示') ? '系统初始化' : '工具结果已返回'}</b></span>`;
                    const detail = document.createElement('div');
                    detail.className = 'ds-fold-detail';
                    detail.textContent = text;
                    row.addEventListener('click', () => {
                        const open = detail.style.display === 'block';
                        detail.style.display = open ? 'none' : 'block';
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
        const knownTags = new Set(['op', 'path', 'reason', 'content', 'old', 'new', 'pattern', 'command', 'question', 'url', 'from', 'to', 'find', 'replace', 'line', 'mode', 'timeout', 'path1', 'path2', 'method', 'headers', 'text', 'options', 'option', 'plugin_name', 'plugin_js', 'cwd', 'ms', 'pid']);
        const extraArgs = {};
        const tagRegex = /<([a-zA-Z0-9_]+)\b[^>]*>([\s\S]*?)<\/\1\s*>/gi;
        let match;
        while ((match = tagRegex.exec(tcStr)) !== null) {
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
            extraArgs
        };
    }

    function parseToolcalls(container) {
        const clone = container.cloneNode(true);
        clone.querySelectorAll('.ds-think-content').forEach(el => el.remove());
        clone.querySelectorAll('.ds-fold-list').forEach(el => el.remove()); // 移除新加的折叠 DOM 防干扰
        const rawTexts = [];
        // 只提取 pre 标签内的文本，彻底放弃对裸文本的兜底，防止思考过程或正文被误识别
        clone.querySelectorAll('pre').forEach(b => rawTexts.push(b.textContent));

        const calls = [];
        for (const rawText of rawTexts) {
            if (!rawText.includes('<toolcall>')) continue;
            const matches = rawText.match(/<toolcall>[\s\S]*?<\/toolcall>/g) || [];
            for (const tcStr of matches) {
                const c = extractCallFromRaw(tcStr);
                if (c) calls.push(c);
            }
        }
        return calls;
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

    async function autoBackup(path) {
        if (await pathInfo(path).catch(() => null)) {
            try {
                const old = await readFile(path);
                await writeFile(path + '.bak', old);
            } catch {}
        }
    }

    // ================== 工具实现 ==================
    async function toolListdir(call) {
        const p = call.path || '.';
        const info = await pathInfo(p).catch(e => { throw stepErr('检查路径', e); });
        if (info?.type === 'file') throw new ToolError('检查路径', `"${p}" 是文件不是目录`, '请用 openfile 读取');
        let listing;
        try { listing = await listDir(p); }
        catch (e) { throw stepErr(`列出目录 "${p}"`, e, '请确认目录存在，可先 listdir "." 查看根目录'); }
        return `目录 ${p}:\n${listing}`;
    }

    async function toolOpenfile(call) {
        if (!call.path) throw new ToolError('参数校验', '缺少 path', '请在 <path> 中提供文件路径');
        const info = await pathInfo(call.path).catch(e => { throw stepErr('检查路径', e); });
        if (!info) throw new ToolError('检查路径', `文件不存在: ${call.path}`, `工作区根目录: ${await workspaceSnapshot()}`);
        if (info.type === 'dir') throw new ToolError('检查路径', `"${call.path}" 是目录`, '请用 listdir');
        let text;
        try { text = await readFile(call.path); } catch (e) { throw stepErr('读取文件', e); }
        const truncated = text.length > 8000;
        return `文件 ${call.path}${truncated ? `（前 8000 字符，共 ${text.length}）` : ''}:\n\`\`\`\n${text.slice(0, 8000)}\n\`\`\``;
    }

    async function toolMkdir(call) {
        if (!call.path) throw new ToolError('参数校验', '缺少 path', '');
        try { await getDirHandle(call.path, true); }
        catch (e) { throw stepErr('创建目录', e); }
        return `已创建目录: ${call.path}`;
    }

    async function toolAppend(call, reason) {
        if (!call.path) throw new ToolError('参数校验', '缺少 path', '');
        if (call.content === undefined) throw new ToolError('参数校验', '缺少 content', '');
        if (!autoMode) {
            if (!await showConfirmDialog('追加内容', call.path, reason, `<div style="background:#000;padding:8px;color:#4ade80;max-height:150px;overflow:auto;white-space:pre-wrap;font-family:ui-monospace,monospace;font-size:11px;">${esc(call.content.slice(0, 500))}</div>`))
                throw new ToolError('用户确认', '用户取消了追加', '');
        }
        try {
            await autoBackup(call.path);
            let old = '';
            if (await pathInfo(call.path)) old = await readFile(call.path);
            await writeFile(call.path, old + call.content);
        } catch (e) { throw stepErr('追加写入', e); }
        return `追加成功: ${call.path}`;
    }

    async function toolGrep(call) {
        if (!call.pattern) throw new ToolError('参数校验', '缺少 pattern', '请在 <pattern> 中提供正则');
        try { return `grep "${call.pattern}" @ ${call.path || '.'}:\n${await grep(call.pattern, call.path || '.')}`; }
        catch (e) { throw stepErr('搜索', e, '检查正则语法是否正确；目录不存在可先 listdir'); }
    }

    async function toolGlob(call) {
        if (!call.pattern) throw new ToolError('参数校验', '缺少 pattern', '例如 **/*.js');
        try { return `glob "${call.pattern}":\n${await glob(call.pattern)}`; }
        catch (e) { throw stepErr('文件名匹配', e); }
    }

    async function toolWritefile(call, reason) {
        if (!call.path) throw new ToolError('参数校验', '缺少 path', '');
        if (call.content === undefined || call.content === null) throw new ToolError('参数校验', '缺少 content', '请在 <content> 中提供文件内容');
        const info = await pathInfo(call.path).catch(e => { throw stepErr('检查路径', e); });
        if (info?.type === 'dir') throw new ToolError('检查路径', `"${call.path}" 是目录，不能写入`, '请提供文件路径');
        if (info && !autoMode) {
            let oldContent = '';
            try { oldContent = await readFile(call.path); } catch {}
            const preview = `<div style="display:flex;gap:8px;margin-top:8px;"><div style="flex:1;background:#000;padding:8px;color:#f87171;max-height:150px;overflow:auto;white-space:pre-wrap;font-family:ui-monospace,monospace;font-size:11px;">旧:\n${esc(oldContent.slice(0, 500))}</div><div style="flex:1;background:#000;padding:8px;color:#4ade80;max-height:150px;overflow:auto;white-space:pre-wrap;font-family:ui-monospace,monospace;font-size:11px;">新:\n${esc(call.content.slice(0, 500))}</div></div>`;
            if (!await showConfirmDialog('覆盖文件', call.path, reason, preview))
                throw new ToolError('用户确认', '用户取消了写入', '');
        }
        try {
            await autoBackup(call.path);
            return await writeFile(call.path, call.content);
        } catch (e) { throw stepErr('写入文件', e, '请确认父目录存在（可先 listdir 或 mkdir），路径不能是目录'); }
    }

    async function toolEdit(call, reason) {
        const { path, old: oldStr, new: newStr } = call;
        if (!path) throw new ToolError('参数校验', '缺少 path', '');
        if (!oldStr) throw new ToolError('参数校验', '缺少 old（原内容，不能为空）', '');
        if (newStr === undefined) throw new ToolError('参数校验', '缺少 new（新内容，可为空）', '');

        const info = await pathInfo(path).catch(e => { throw stepErr('检查路径', e); });
        if (!info) throw new ToolError('检查路径', `文件不存在: ${path}`, `根目录: ${await workspaceSnapshot()}`);
        if (info.type === 'dir') throw new ToolError('检查路径', `"${path}" 是目录`, '请用 openfile');

        let original;
        try { original = await readFile(path); } catch (e) { throw stepErr('读取文件', e); }

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

        try {
            await autoBackup(path);
            await writeFile(path, original.slice(0, firstIdx) + newStr + original.slice(firstIdx + oldStr.length));
        } catch (e) { throw stepErr('写入文件', e); }
        return `替换成功（第 ${lineNo} 行，${oldStr.length} 字符 → ${newStr.length} 字符）`;
    }

    async function toolEditLine(call, reason) {
        const { path, line, mode, content } = call;
        if (!path) throw new ToolError('参数校验', '缺少 path', '');
        const lineNo = parseInt(line, 10);
        if (isNaN(lineNo) || lineNo < 1) throw new ToolError('参数校验', 'line 必须为正整数', '');
        if (mode !== 'delete' && content === undefined) throw new ToolError('参数校验', '缺少 content', '');

        const info = await pathInfo(path).catch(e => { throw stepErr('检查路径', e); });
        if (!info || info.type === 'dir') throw new ToolError('检查路径', `文件不存在或不是文件: ${path}`, '');

        let original;
        try { original = await readFile(path); } catch (e) { throw stepErr('读取文件', e); }
        const lines = original.split('\n');
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

        try {
            await autoBackup(path);
            await writeFile(path, lines.join('\n'));
        } catch (e) { throw stepErr('写入文件', e); }
        return `已执行 ${mode} (第 ${lineNo} 行)`;
    }

    async function toolReplaceAll(call, reason) {
        if (!call.find) throw new ToolError('参数校验', '缺少 find', '');
        if (call.replace === undefined) throw new ToolError('参数校验', '缺少 replace', '');
        const target = call.path || '.';
        const info = await pathInfo(target).catch(e => { throw stepErr('检查路径', e); });
        if (!info) throw new ToolError('检查路径', `目标不存在: ${target}`, '');

        let replacedFiles = 0, replacedCount = 0;

        async function processFile(relPath, fileEntry) {
            if (/\.bak$/i.test(relPath)) return;
            const file = await fileEntry.getFile();
            if (file.size > MAX_FILE) return;
            const text = await file.text();
            if (isBinary(text)) return;
            if (!text.includes(call.find)) return;

            const parts = text.split(call.find);
            const count = parts.length - 1;
            if (count === 0) return;

            if (!autoMode) {
                const preview = `<div style="font-size:11px;color:#888;">文件：${relPath}，替换次数：${count}</div>`;
                if (!await showConfirmDialog('批量替换', target, reason, preview))
                    throw new ToolError('用户确认', '用户取消了批量替换', '');
            }

            try {
                await autoBackup(relPath);
                await writeFile(relPath, parts.join(call.replace));
            } catch (e) {
                throw stepErr(`写回 ${relPath}`, e, '确认目录下文件可写、未被占用');
            }
            replacedFiles++;
            replacedCount += count;
        }

        if (info.type === 'file') {
            const fh = await getFileHandle(target);
            await processFile(target, fh);
        } else {
            const prefix0 = parsePath(target).join('/');
            async function walk(dir, prefix, depth) {
                if (depth > MAX_DEPTH) return;
                for await (const entry of dir.values()) {
                    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
                    if (entry.kind === 'directory') {
                        if (SKIP_DIRS.has(entry.name.toLowerCase())) continue;
                        await walk(entry, rel, depth + 1);
                    } else {
                        if (/\.bak$/i.test(entry.name)) continue;
                        const ext = '.' + entry.name.split('.').pop().toLowerCase();
                        if (SKIP_EXTS.has(ext)) continue;
                        await processFile(rel, entry);
                    }
                }
            }
            await walk(await getDirHandle(target), prefix0, 0);
        }

        return `批量替换完成：${replacedFiles} 个文件，共 ${replacedCount} 处`;
    }

    async function toolDel(call, reason) {
        if (!call.path) throw new ToolError('参数校验', '缺少 path', '');
        const info = await pathInfo(call.path).catch(e => { throw stepErr('检查路径', e); });
        if (!info) throw new ToolError('检查路径', `路径不存在: ${call.path}`, `根目录: ${await workspaceSnapshot()}`);
        if (!autoMode && !await showConfirmDialog(info.type === 'dir' ? '删除目录' : '删除文件', call.path, reason))
            throw new ToolError('用户确认', '用户取消了删除', '');
        try { await deletePath(call.path, info.type === 'dir'); }
        catch (e) { throw stepErr(`删除${info.type === 'dir' ? '目录' : '文件'}`, e, info.type === 'dir' ? '目录非空需递归删除，或先用 exec' : ''); }
        return `已删除 ${info.type === 'dir' ? '目录' : '文件'}: ${call.path}`;
    }

    async function toolExec(call, reason, silent = true) {
        if (!call.command) throw new ToolError('参数校验', '缺少 command', '');
        if (!silent && !autoMode) {
            const res = await showCmdDialog(call.command, reason);
            if (res.cancel) throw new ToolError('用户确认', '用户取消了命令执行', '');
            return `输出:\n\`\`\`\n${res.output || '(无输出)'}\n\`\`\``;
        }

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

        const fromInfo = await pathInfo(from).catch(e => { throw stepErr('检查源路径', e); });
        if (!fromInfo) throw new ToolError('检查源路径', `源路径不存在: ${from}`, `工作区根目录: ${await workspaceSnapshot()}`);

        const target = await resolveTarget(from, to);
        if (target === from) throw new ToolError('检查目标路径', '源与目标是同一个路径', '无需移动');
        const toInfo = await pathInfo(target).catch(() => null);
        if (toInfo) throw new ToolError('检查目标路径', `目标已存在: ${target}（${toInfo.type}）`, '请更换目标名，或先 del 删除目标');

        if (fromInfo.type === 'file') {
            let nativeOk = false;
            try {
                const fh = await getFileHandle(from);
                if (typeof fh.move === 'function') {
                    const parts = parsePath(target);
                    const newName = parts.pop();
                    const newDir = parts.length ? await getDirHandle(parts.join('/'), true) : dirHandle;
                    await fh.move(newDir, newName);
                    nativeOk = true;
                }
            } catch (e) {
                log(`原生 move 失败（${e.message}），回退到 读→写→删`);
            }
            if (nativeOk) return `已移动 ${from} → ${target}（原生 rename）`;

            let data;
            try { data = await readFileBinary(from); }
            catch (e) { throw stepErr(`第1步 读取源文件 "${from}"`, e, '请先 stat 确认文件存在且可读'); }

            try { await writeFileBinary(target, data); }
            catch (e) { throw stepErr(`第2步 写入目标 "${target}"`, e, '检查目标父目录是否存在、是否可写'); }

            try {
                const f = await (await getFileHandle(target)).getFile();
                if (f.size !== data.byteLength) {
                    await deletePath(target, false).catch(() => {});
                    throw new ToolError('第2步 校验目标', `大小不符: 预期 ${data.byteLength} 实际 ${f.size}`, '已回滚目标文件');
                }
            } catch (e) {
                if (e instanceof ToolError) throw e;
                await deletePath(target, false).catch(() => {});
                throw stepErr('第2步 校验目标', e, '已回滚目标文件');
            }

            try { await deletePath(from, false); }
            catch (e) {
                await deletePath(target, false).catch(() => {});
                throw stepErr(`第3步 删除源文件 "${from}"`, e, '目标已回滚，源文件仍在原处');
            }
            return `已移动 ${from} → ${target}（${data.byteLength} 字节）`;
        }

        try {
            const srcDir = await getDirHandle(from);
            const parts = parsePath(target);
            const name = parts.pop();
            const parent = parts.length ? await getDirHandle(parts.join('/'), true) : dirHandle;
            if (typeof srcDir.move === 'function') {
                await srcDir.move(parent, name);
                return `已移动目录 ${from} → ${target}（原生）`;
            }
            const dst = await parent.getDirectoryHandle(name, { create: true });
            await copyDirInto(srcDir, dst);
            await deletePath(from, true);
            return `已移动目录 ${from} → ${target}（递归复制+删除）`;
        } catch (e) {
            if (e instanceof ToolError) throw e;
            throw stepErr('移动目录', e, '可尝试先 copy 再 del');
        }
    }

    async function toolCopy(call) {
        const { from, to } = call;
        if (!from) throw new ToolError('参数校验', '缺少 from', '');
        if (!to) throw new ToolError('参数校验', '缺少 to', '');

        const srcInfo = await pathInfo(from).catch(e => { throw stepErr('检查源路径', e); });
        if (!srcInfo) throw new ToolError('检查源路径', `源路径不存在: ${from}`, `工作区根目录: ${await workspaceSnapshot()}`);

        const target = await resolveTarget(from, to);
        if (target === from) throw new ToolError('检查目标路径', '源与目标是同一个路径', '');
        if (await pathInfo(target).catch(() => null))
            throw new ToolError('检查目标路径', `目标已存在: ${target}`, '请更换目标名，或先 del');

        if (srcInfo.type === 'file') {
            let data;
            try { data = await readFileBinary(from); }
            catch (e) { throw stepErr(`读取源文件 "${from}"`, e); }
            try { await writeFileBinary(target, data); }
            catch (e) { throw stepErr(`写入目标 "${target}"`, e, '检查父目录是否存在'); }
            return `已复制 ${from} → ${target}（${data.byteLength} 字节）`;
        }

        try {
            const srcDir = await getDirHandle(from);
            const parts = parsePath(target);
            const name = parts.pop();
            const parent = parts.length ? await getDirHandle(parts.join('/'), true) : dirHandle;
            const dst = await parent.getDirectoryHandle(name, { create: true });
            await copyDirInto(srcDir, dst);
            return `已复制目录 ${from} → ${target}`;
        } catch (e) {
            if (e instanceof ToolError) throw e;
            throw stepErr('复制目录', e);
        }
    }

    async function toolStat(call) {
        if (!call.path) throw new ToolError('参数校验', '缺少 path', '');
        const info = await pathInfo(call.path).catch(e => { throw stepErr('检查路径', e); });
        if (!info) throw new ToolError('检查路径', `路径不存在: ${call.path}`, `根目录: ${await workspaceSnapshot()}`);
        if (info.type === 'dir') return `类型: 目录\n路径: ${call.path}`;
        try {
            const file = await (await getFileHandle(call.path)).getFile();
            return `类型: 文件\n路径: ${call.path}\n大小: ${(file.size/1024).toFixed(2)} KB (${file.size} 字节)\n修改时间: ${new Date(file.lastModified).toLocaleString()}`;
        } catch (e) { throw stepErr('读取文件信息', e); }
    }

    async function toolDiff(call) {
        if (!call.path1 || !call.path2) throw new ToolError('参数校验', '需要 path1 和 path2', '');
        let t1, t2;
        try { t1 = await readFile(call.path1); } catch (e) { throw stepErr(`读取 "${call.path1}"`, e); }
        try { t2 = await readFile(call.path2); } catch (e) { throw stepErr(`读取 "${call.path2}"`, e); }
        const l1 = t1.split('\n'), l2 = t2.split('\n');
        let out = `--- ${call.path1}\n+++ ${call.path2}\n`;
        let diffs = 0;
        const max = Math.max(l1.length, l2.length);
        for (let i = 0; i < max; i++) {
            if (l1[i] !== l2[i]) {
                if (l1[i] !== undefined) out += `- ${l1[i]}\n`;
                if (l2[i] !== undefined) out += `+ ${l2[i]}\n`;
                diffs++;
                if (diffs > 100) { out += '... (差异过多，已截断)'; break; }
            }
        }
        return diffs === 0 ? '两文件内容完全一致' : out;
    }

    async function toolHash(call) {
        if (!call.path) throw new ToolError('参数校验', '缺少 path', '');
        try {
            const buf = await readFileBinary(call.path);
            const hashBuf = await crypto.subtle.digest('SHA-256', buf);
            const hex = Array.from(new Uint8Array(hashBuf)).map(b => b.toString(16).padStart(2, '0')).join('');
            return `SHA-256: ${hex}\n大小: ${buf.byteLength} 字节`;
        } catch (e) { throw stepErr('计算哈希', e); }
    }

    async function toolWaitFile(call) {
        if (!call.path) throw new ToolError('参数校验', '缺少 path', '');
        const timeout = call.timeout ? parseInt(call.timeout, 10) : 30000;
        const start = Date.now();
        while (Date.now() - start < timeout) {
            if (await pathInfo(call.path).catch(() => null)) return `文件已出现: ${call.path}`;
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
        const info = await pathInfo(call.path).catch(e => { throw stepErr('检查路径', e); });
        if (!info) throw new ToolError('检查路径', `文件不存在: ${call.path}`, `根目录: ${await workspaceSnapshot()}`);
        if (info.type === 'dir') throw new ToolError('检查路径', `"${call.path}" 是目录`, '请用 listdir');
        let c;
        try { c = await readFile(call.path); } catch (e) { throw stepErr('读取文件', e); }
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
        const info = await pathInfo(call.path).catch(e => { throw stepErr('检查路径', e); });
        if (!info) throw new ToolError('检查路径', `文件不存在: ${call.path}`, `根目录: ${await workspaceSnapshot()}`);
        if (info.type === 'dir') throw new ToolError('检查路径', `"${call.path}" 是目录`, '');
        let file;
        try { file = await (await getFileHandle(call.path)).getFile(); }
        catch (e) { throw stepErr('读取文件', e); }
        if (file.size > 5 * 1024 * 1024) throw new ToolError('检查大小', `图片 ${(file.size/1024/1024).toFixed(1)}MB 超过 5MB`, '请先压缩或用 exec 处理');
        const dataUrl = await new Promise(res => { const r = new FileReader(); r.onload = e => res(e.target.result); r.readAsDataURL(file); });
        const img = document.createElement('img');
        img.src = dataUrl;
        img.style.cssText = 'max-width:100%;border-radius:8px;margin-top:8px;';
        msgEl?.appendChild(img);
        return `图片已展示: ${call.path}`;
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
                url: call.url, method: call.method, content: call.content, headers: headersObj
            }, 40000);
            if (!resp.ok) {
                const err = await resp.json().catch(() => ({}));
                throw new ToolError('本地服务', err.error || `HTTP ${resp.status}`, err.hint || '检查本地服务是否运行、目标是否可达');
            }
            const data = await resp.json();
            const t = data.text || '';
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

    async function toolChmod(call) {
        if (!call.path) throw new ToolError('参数校验', '缺少 path', '');
        if (!call.mode) throw new ToolError('参数校验', '缺少 mode', '类 Unix：755/644/+x；Windows：+R/-R');
        const info = await pathInfo(call.path).catch(e => { throw stepErr('检查路径', e); });
        if (!info) throw new ToolError('检查路径', `路径不存在: ${call.path}`, '');

        const normPath = parsePath(call.path).join('/');
        const fullPath = absPath ? absPath.replace(/\\/g, '/').replace(/\/$/, '') + '/' + normPath : normPath;
        const winPath = fullPath.replace(/\//g, '\\');

        const isAttribStyle = /^[+-][RASH]$/i.test(String(call.mode).trim());
        const primaryCmd   = isAttribStyle ? `attrib ${call.mode.toUpperCase()} "${winPath}"` : `chmod ${call.mode} "${fullPath}"`;
        const fallbackCmd  = isAttribStyle ? `chmod ${call.mode} "${fullPath}"`               : `attrib +R "${winPath}"`;

        const run = async (cmd) => {
            const resp = await agentFetch('/exec', { command: cmd, cwd: absPath, timeout: 10000 }, 15000);
            const data = await resp.json();
            return data;
        };

        try {
            let data = await run(primaryCmd);
            if (data.exitCode === 0) return `已设置权限: ${call.mode} → ${call.path}`;
            data = await run(fallbackCmd);
            if (data.exitCode === 0) return `已设置权限: ${call.mode} → ${call.path}（备选方式）`;
            throw new ToolError('执行 chmod', `命令均失败: ${data.output || '(无输出)'}`,
                '类 Unix 用 chmod 755/644/+x；Windows 用 attrib +R/-R 或 icacls');
        } catch (e) {
            if (e instanceof ToolError) throw e;
            throw stepErr('调用本地服务', e, '请确认本地服务已启动、token 正确、absPath 有效');
        }
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

            // 避免重复注册
            const existingIdx = W.DS_Agent_Plugins.findIndex(p => p.name === pluginName);
            if (existingIdx >= 0) {
                W.DS_Agent_Plugins[existingIdx] = pluginObj;
                return `插件 "${pluginName}" 已更新成功。请直接在当前对话的下一轮调用该插件。`;
            } else {
                W.DS_Agent_Plugins.push(pluginObj);
                return `插件 "${pluginName}" 注册成功！请直接在当前对话的下一轮调用该插件。`;
            }

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
            case 'waitfile': return toolWaitFile(call);
            case 'ask': return toolAsk(call, reason);
            case 'exec': return toolExec(call, reason, true);
            case 'autocmd': return toolExec(call, reason, true);
            case 'runcmd': return toolExec(call, reason, false);
            case 'preview': return toolPreview(call, msgEl);
            case 'openurl': return toolOpenurl(call);
            case 'image': return toolImage(call, msgEl);
            case 'fetch': return toolFetch(call);
            case 'clipboard': return toolClipboard(call);
            case 'chmod': return toolChmod(call);
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

            const arrowSpan = item.querySelector('.ds-fold-arrow');
            if (arrowSpan) {
                if (!arrowSpan.getAttribute('data-state') || arrowSpan.getAttribute('data-state') !== status) {
                    arrowSpan.innerHTML = icon;
                    arrowSpan.style.color = color;
                    arrowSpan.setAttribute('data-state', status);
                }
            }
        });
    }

    function packResults(results) {
        let text = '【系统执行结果】\n';
        for (const r of results) {
            const tag = r.status === 'error' ? '[失败]' : (r.status === 'cancel' ? '[取消]' : '[成功]');
            text += `${tag} ${r.op}${r.path ? ` (${r.path})` : ''}:\n${r.msg}\n\n`;
        }
        text += '⚠️ 【格式警告】下一步调用工具时，请务必、一定、必须把完整的 <toolcall> 放进 ```toolcall 代码块中！不要只输出裸标签！';
        return text;
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
            const st = msgStore.get(key);
            if (!st || !st.done) continue;
            const allCalls = parseToolcalls(item);
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
        const SLOW_OPS = ['sleep', 'waitfile', 'exec', 'fetch', 'runcmd', 'ask'];
        for (const entry of toExec) {
            const call = entry.call;
            const sig = entry.sig;
            const st = entry.st;
            toolcallCounter++;
            log(`执行 ${call.op} ${displayFor(call)}`);
            let result;
            // 需要用户弹窗确认的操作：不限时，等用户点完再继续
            const NEEDS_CONFIRM = ['runcmd', 'ask'];
            const isConfirmOp = NEEDS_CONFIRM.includes(call.op) ||
                (!autoMode && ['writefile', 'append', 'edit', 'editline', 'replaceall', 'del'].includes(call.op));
            let TOOL_TIMEOUT_MS = 5000;
            if (isConfirmOp) {
                TOOL_TIMEOUT_MS = 0; // 0 = 不限时
            } else if (SLOW_OPS.includes(call.op)) {
                const ut = call.timeout ? parseInt(call.timeout, 10) : 0;
                if (call.op === 'sleep' || call.op === 'waitfile') TOOL_TIMEOUT_MS = (ut || 30000) + 2000;
                else if (call.op === 'exec') TOOL_TIMEOUT_MS = (ut || 30000) + 10000;
                else if (call.op === 'fetch') TOOL_TIMEOUT_MS = 45000;
                else TOOL_TIMEOUT_MS = 5 * 60 * 1000;
            }
            try {
                if (TOOL_TIMEOUT_MS === 0) {
                    // 不限时（弹窗确认类 / 已由 awaitingUser 保护）
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
                // 写操作后留出 50ms，让底层文件句柄释放，避免紧接的读操作卡死
                if (['writefile', 'append', 'edit', 'editline', 'replaceall', 'move', 'copy'].includes(call.op)) {
                    await sleep(50);
                }
            } catch (e) {
                result = { op: call.op, path: call.path, status: 'error', msg: `[失败] ${call.op}\n原因: ${e.message}` };
            }
            st.sigs.add(sig);
            log(`→ ${result.status}: ${String(result.msg).split('\n')[0]}`);
            results.push(result);
        }

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

        isCooldown = true;
        if (cooldownTimer) clearTimeout(cooldownTimer);
        cooldownTimer = setTimeout(() => {
            isCooldown = false;
            if (isModeOn) dsSetStatus('active', '监听中');
            checkAndProcess();
        }, 1500);
    }

    async function checkAndProcess() {
        if (!isModeOn || !dirHandle) return;
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
            if (!isModeOn) return;
            hideToolResultMessages();
            if (rafPending) return;
            rafPending = true;
            requestAnimationFrame(() => {
                rafPending = false;
                if (!isModeOn) return;
                scanMessages();
                foldAllToolcalls();
                checkAndProcess();
            });
        });
        observer.observe(document.body, { childList: true, subtree: true, characterData: true });
        pollInterval = setInterval(() => {
            if (!isModeOn) return;
            hideToolResultMessages();
            foldAllToolcalls();
            checkAndProcess();
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
                <div style="display:flex;align-items:center;font-weight:600;color:var(--dsw-alias-brand-primary,#4CAF50);gap:6px;">
                    <span id="ds-dot" class="ds-status-dot"></span>本地互联
                </div>
                <span id="ds-status" style="font-size:12px;color:#aaa;">未连接</span>
            </div>
            <div id="ds-setup-container" style="display:flex;flex-direction:column;gap:8px;">
                <div id="ds-abs-container" style="display:none;flex-direction:column;gap:4px;">
                    <span style="font-size:11px;color:#888;line-height:1.4;">后端工作区（由本地服务自动提供）:</span>
                    <code id="ds-workspace-path" style="font-size:11px;color:#4CAF50;word-break:break-all;line-height:1.5;">（点击"下一步"后自动获取）</code>
                    <span style="font-size:11px;color:#888;line-height:1.4;margin-top:4px;">本地服务 Token（server 启动时打印，可选）:</span>
                    <input id="ds-token-input" class="ds-input" type="password" placeholder="留空表示不使用 token" />
                </div>
                <div id="ds-goal-container" style="display:none;flex-direction:column;gap:6px;">
                    <span style="font-size:11px;color:#888;">本次任务目标:</span>
                    <input id="ds-goal-input" class="ds-input" type="text" placeholder="输入目标（留空则由 AI 自行探索）" />
                    <span style="font-size:11px;color:#888;margin-top:4px;">启动方式:</span>
                    <label style="font-size:12px;color:#ccc;display:flex;align-items:center;gap:6px;cursor:pointer;">
                        <input type="radio" name="ds-start-mode" value="new" checked> 在新对话开始（推荐）
                    </label>
                    <label style="font-size:12px;color:#ccc;display:flex;align-items:center;gap:6px;cursor:pointer;">
                        <input type="radio" name="ds-start-mode" value="here"> 在当前对话内开始
                    </label>
                </div>
                <button id="ds-connect-btn" class="ds-btn ds-btn-primary">开启模式</button>
            </div>
            <div id="ds-main-container" style="display:none;flex-direction:column;gap:8px;">
                <label style="font-size:12px;color:#888;display:flex;align-items:center;gap:6px;cursor:pointer;">
                    <input type="checkbox" id="ds-auto-toggle"> 完全权限（跳过确认/自动执行命令）
                </label>
                <label style="font-size:12px;color:#888;display:flex;align-items:center;gap:6px;cursor:pointer;">
                    <input type="checkbox" id="ds-throttle-toggle" checked> 开启防封控冷却（连续10次后暂停）
                </label>
                <button id="ds-disconnect-btn" class="ds-btn ds-btn-danger">断开连接</button>
                <div id="ds-log" class="ds-log-area"></div>
            </div>`;
        newChatBtn.parentNode.insertBefore(panel, newChatBtn.nextSibling);

        const $ = (id) => document.getElementById(id);
        const dot = $('ds-dot'), statusEl = $('ds-status'), logEl = $('ds-log');
        const connectBtn = $('ds-connect-btn'), disconnectBtn = $('ds-disconnect-btn');
        const setupContainer = $('ds-setup-container'), mainContainer = $('ds-main-container');
        const absContainer = $('ds-abs-container'), workspacePathEl = $('ds-workspace-path');
        const tokenInput = $('ds-token-input');
        const goalContainer = $('ds-goal-container'), goalInput = $('ds-goal-input');
        const autoToggle = $('ds-auto-toggle');
        const throttleToggle = $('ds-throttle-toggle');

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
        autoToggle.addEventListener('change', () => { autoMode = autoToggle.checked; });
        throttleToggle.addEventListener('change', () => { autoThrottle = throttleToggle.checked; });

        connectBtn.addEventListener('click', async () => {
            if (step === 0) {
                try {
                    tempDirHandle = await W.showDirectoryPicker({ mode: 'readwrite' });
                } catch { return; }
                step = 1;
                absContainer.style.display = 'flex';
                workspacePathEl.textContent = '（点击"下一步"后自动获取）';
                tokenInput.value = agentToken;
                connectBtn.textContent = '下一步';
                dsSetStatus('working', '填写 Token');
                return;
            }
            if (step === 1) {
                agentToken = tokenInput.value.trim();
                if (agentToken) localStorage.setItem(TOKEN_KEY, agentToken);
                else localStorage.removeItem(TOKEN_KEY);
                dsSetStatus('working', '获取工作区...');
                try {
                    const resp = await agentFetch('/workspace', {}, 8000);
                    if (!resp.ok) throw new Error('HTTP ' + resp.status);
                    const data = await resp.json();
                    if (!data.cwd) throw new Error('后端返回为空');
                    absPath = data.cwd;
                } catch (e) {
                    alert('无法获取后端工作区：' + e.message + '\n请确认 server.js 正在运行、Token 正确。');
                    dsSetStatus('none', '获取失败');
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

                dirHandle = tempDirHandle;
                step = 3; isModeOn = true;
                setupContainer.style.display = 'none';
                mainContainer.style.display = 'flex';
                dsSetStatus('active', `已连接: ${dirHandle.name}`);
                await fetchServerPlugins();
                log(`授权成功: ${dirHandle.name}`);
                msgStore.clear();
        toolcallStatusMap.clear();
                currentChatUrl = location.href;

                const herePrompt = `现在开始，你可以使用工具了。\n\n【工作区信息】\n绝对路径：${absPath}\n当前目标：${goal}`;

                if (startMode === 'here') {
                    log('启动方式: 当前对话内开始');
                    setTimeout(async () => {
                        const r = await sendMessage(herePrompt);
                        if (!r.ok) log(`启动消息发送失败: ${r.reason}`);
                        else log('启动消息已发送');
                        startObserver();
                    }, 300);
                } else {
                    log('启动方式: 新对话开始');
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
            step = 0; isModeOn = false; dirHandle = null; tempDirHandle = null;
            isProcessing = false; isCooldown = false; isCompressing = false; autoMode = false;
            processingStart = 0;
            if (cooldownTimer) { clearTimeout(cooldownTimer); cooldownTimer = null; }
            executedSigs.clear();
            msgStore.clear();
        toolcallStatusMap.clear();
            pendingResults = null;
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
        });

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
        }
    }, 1000);

})();