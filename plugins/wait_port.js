const net = require('net');

const V = (a, k) => {
    if (!a) return '';
    if (a[k] != null && a[k] !== '') return String(a[k]);
    const ex = a.extraArgs || {};
    if (ex[k] != null && ex[k] !== '') return String(ex[k]);
    const lower = k.toLowerCase();
    for (const key of Object.keys(ex)) { if (key.toLowerCase() === lower && ex[key] != null) return String(ex[key]); }
    // 从原始 toolcall 文本中按标签名精确提取（避免与其他标签的数字混淆）
    if (ex.toolcall) {
        const m = String(ex.toolcall).match(new RegExp('<' + k + '>([\\s\\S]*?)<\\/' + k + '>', 'i'));
        if (m) {
            let v = m[1];
            const c = v.match(/^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/);
            if (c) v = c[1];
            return v.trim();
        }
    }
    return '';
};

function probe(host, port, timeout) {
    return new Promise((resolve) => {
        const sock = new net.Socket();
        let done = false;
        const finish = (ok, err) => {
            if (done) return;
            done = true;
            try { sock.destroy(); } catch (e) {}
            resolve({ ok, err });
        };
        sock.setTimeout(timeout || 1500);
        sock.once('connect', () => finish(true));
        sock.once('timeout', () => finish(false, '超时'));
        sock.once('error', (e) => finish(false, e.code || e.message));
        try { sock.connect(port, host); } catch (e) { finish(false, e.message); }
    });
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

module.exports = {
    name: 'wait_port',
    description: "等待 TCP 端口开放或关闭，服务自测必备",
    params: [
        { k: "port", cn: "端口", req: true, d: "可逗号分隔多个" },
        { k: "host", cn: "主机", req: false, d: "默认 127.0.0.1" },
        { k: "timeout", cn: "超时", req: false, d: "毫秒，默认 15000" },
        { k: "interval", cn: "间隔", req: false, d: "毫秒，默认 500" },
        { k: "expect", cn: "期望状态", req: false, d: "open / closed，默认 open" }
    ],
    execute: async (args) => {
        // port 非内置参数名，可能落在 extraArgs；V() 已支持按标签名精确提取，优先使用
        let portsRaw = V(args, 'port') || V(args, 'ports');
        // 兜底1：常见写法 text 直接给端口
        if (!portsRaw) {
            const t = V(args, 'text');
            if (t && /^\s*\d+(\s*,\s*\d+)*\s*$/.test(t)) portsRaw = t;
        }
        // 兜底2：从 toolcall 原文里只抓 <port> / <ports> 标签的数字，绝不抓全文
        if (!portsRaw && args && args.extraArgs && args.extraArgs.toolcall) {
            const s = String(args.extraArgs.toolcall);
            const m = s.match(/<ports?>([\s\S]*?)<\/ports?>/i);
            if (m) portsRaw = (m[1].match(/\d{1,5}/g) || []).join(',');
        }
        if (!portsRaw) {
            let dump = '';
            try { dump = JSON.stringify(args); } catch (e) { dump = String(args); }
            return '错误：缺少 port。用法示例：{"op":"wait_port","port":"3000","timeout":20000}（诊断：' + dump + '）';
        }
        const ports = portsRaw.split(',').map(s => parseInt(s.trim(), 10)).filter(n => !isNaN(n));
        if (!ports.length) return '错误：port 无效';
        const host = V(args, 'host') || '127.0.0.1';
        const timeout = Math.min(Math.max(parseInt(V(args, 'timeout') || '15000', 10) || 15000, 500), 300000);
        const interval = Math.min(Math.max(parseInt(V(args, 'interval') || '500', 10) || 500, 100), 5000);
        const expect = (V(args, 'expect') || 'open').toLowerCase() === 'closed' ? 'closed' : 'open';

        const t0 = Date.now();
        const pending = new Set(ports);
        const detail = {};

        while (Date.now() - t0 < timeout && pending.size) {
            for (const p of Array.from(pending)) {
                const r = await probe(host, p, 1500);
                const state = r.ok ? 'open' : 'closed';
                detail[p] = state + (r.err ? ' (' + r.err + ')' : '');
                if (state === expect) pending.delete(p);
            }
            if (pending.size) await sleep(interval);
        }

        const cost = Date.now() - t0;
        const lines = ports.map(p => {
            const ok = detail[p] && detail[p].startsWith(expect);
            return (ok ? '✅ ' : '⏳ ') + host + ':' + p + ' → ' + (detail[p] || '未探测');
        });

        if (!pending.size) return `端口全部就绪（${expect}）✅  耗时 ${cost}ms\n` + lines.join('\n');
        return `等待超时（${timeout}ms），仍不满足 expect=${expect} ❌\n` + lines.join('\n');
    }
};
