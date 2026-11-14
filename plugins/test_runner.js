const { resolveWsPath } = require('./_workspace');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const V = (a, k) => {
    if (!a) return '';
    if (a[k] != null && a[k] !== '') return String(a[k]);
    const ex = a.extraArgs || {};
    if (ex[k] != null && ex[k] !== '') return String(ex[k]);
    const lower = k.toLowerCase();
    for (const key of Object.keys(ex)) { if (key.toLowerCase() === lower && ex[key] != null) return String(ex[key]); }
    if (ex.toolcall) {
        const m = String(ex.toolcall).match(new RegExp('<' + k + '>([\\s\\S]*?)<\\/' + k + '>', 'i'));
        if (m) { let v = m[1]; const c = v.match(/^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/); if (c) v = c[1]; return v.trim(); }
    }
    return '';
};

function detect(ws) {
    const pkgPath = path.join(ws, 'package.json');
    if (fs.existsSync(pkgPath)) {
        try {
            const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
            const t = pkg.scripts && pkg.scripts.test;
            if (t && !/no test specified/i.test(t)) return { command: 'npm test', reason: 'package.json 的 scripts.test' };
        } catch (e) { /* ignore */ }
    }
    const pyCandidates = ['pytest.ini', 'tox.ini', 'setup.cfg', 'pyproject.toml'];
    if (pyCandidates.some(f => fs.existsSync(path.join(ws, f)))) {
        return { command: 'python -m pytest -q', reason: '检测到 Python 测试配置' };
    }
    for (const d of ['tests', 'test', 'src/test', 'tests/unit']) {
        const p = path.join(ws, d);
        if (!fs.existsSync(p)) continue;
        try {
            const hits = fs.readdirSync(p).filter(f => /^test_.*\.py$|.*_test\.py$/.test(f));
            if (hits.length) return { command: 'python -m pytest -q ' + d, reason: '检测到 ' + d + ' 下的 Python 测试文件' };
        } catch (e) { /* ignore */ }
    }
    return null;
}

function summarize(out) {
    const hits = [];
    const re = /(\d+\s+(passed|failed|error|errors|skipped|xfailed|xpassed))|Ran \d+ test|Test Suites?:|Test Files?:|Tests?:.*\d|^(PASS|FAIL|ok)\b|^FAILED\b|All tests passed/i;
    for (const ln of String(out || '').split(/\r?\n/)) {
        const s = ln.trim();
        if (!s) continue;
        if (re.test(s)) hits.push(s);
        if (hits.length >= 25) break;
    }
    return hits;
}

function tail(out, n) {
    const s = String(out || '');
    return s.length > n ? '...(截断)...\n' + s.slice(-n) : s;
}

module.exports = {
    name: 'test_runner',
    description: "自动识别并运行项目测试命令",
    params: [
        { k: "command", cn: "命令", req: false, d: "如 npm test" },
        { k: "cwd", cn: "工作目录", req: false, d: "默认工作区根" },
        { k: "timeout", cn: "超时", req: false, d: "毫秒，默认 120000" },
        { k: "tailChars", cn: "输出尾部字符", req: false, d: "默认 4000" }
    ],
    execute: async (args) => {
        const ws = await resolveWsPath('');
        let command = V(args, 'command');
        let reason = '手动指定';
        if (!command) {
            const d = detect(ws);
            if (!d) return '未识别到测试命令。请通过 command 参数指定，例如 npm test / python -m pytest -q / node --test';
            command = d.command;
            reason = d.reason;
        }
        const cwdArg = V(args, 'cwd');
        const cwd = cwdArg ? await resolveWsPath(cwdArg) : ws;
        if (!fs.existsSync(cwd)) return '错误：cwd 不存在 ' + cwdArg;
        const timeoutMs = Math.min(Math.max(parseInt(V(args, 'timeout') || '120000', 10) || 120000, 1000), 600000);
        const tailChars = Math.min(Math.max(parseInt(V(args, 'tailChars') || '4000', 10) || 4000, 200), 20000);

        const t0 = Date.now();
        const r = spawnSync(command, {
            shell: true,
            cwd,
            timeout: timeoutMs,
            encoding: 'utf8',
            maxBuffer: 30 * 1024 * 1024,
            env: Object.assign({}, process.env, { FORCE_COLOR: '0', NO_COLOR: '1', CI: '1' })
        });
        const cost = Date.now() - t0;

        if (r.error && r.error.code === 'ETIMEDOUT') {
            return `测试超时（${timeoutMs}ms）\n命令: ${command}\n${tail((r.stdout || '') + '\n' + (r.stderr || ''), tailChars)}`;
        }

        const code = r.status == null ? -1 : r.status;
        const out = (r.stdout || '') + (r.stderr ? '\n' + r.stderr : '');
        const sum = summarize(out);
        const verdict = code === 0 ? '✅ 通过（退出码 0）' : '❌ 失败（退出码 ' + code + '）';

        const lines = [];
        lines.push('命令: ' + command + '  [' + reason + ']');
        lines.push('耗时: ' + (cost / 1000).toFixed(2) + 's');
        lines.push('结果: ' + verdict);
        if (sum.length) lines.push('摘要:\n' + sum.map(s => '  ' + s).join('\n'));
        lines.push('输出(尾部):\n' + tail(out.trim(), tailChars));
        return lines.join('\n');
    }
};
