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

const LANG = {
    node: { bin: process.execPath, exts: ['.js', '.mjs', '.cjs', '.ts'] },
    python: { bin: null, exts: ['.py'] },
    shell: { bin: null, exts: ['.sh', '.bat', '.cmd', '.ps1'] }
};

function pickLang(file, hint) {
    if (hint) return hint.toLowerCase();
    const ext = path.extname(file).toLowerCase();
    if (LANG.node.exts.includes(ext)) return 'node';
    if (LANG.python.exts.includes(ext)) return 'python';
    if (LANG.shell.exts.includes(ext)) return ext === '.ps1' ? 'powershell' : 'shell';
    return null;
}

function which(cmd, args) {
    const r = spawnSync(cmd, args || ['--version'], { encoding: 'utf8', timeout: 8000 });
    if (r.error) return null;
    if (r.status !== 0 && r.status != null && r.status !== 1 && r.status !== 2) return null;
    return ((r.stdout || '') + (r.stderr || '')).split(/\r?\n/)[0] || 'ok';
}

function buildCmd(lang, file, extraArgs) {
    if (lang === 'node') return [process.execPath, [file].concat(extraArgs)];
    if (lang === 'python') return ['python', [file].concat(extraArgs)];
    if (lang === 'python3') return ['python3', [file].concat(extraArgs)];
    if (lang === 'shell') {
        const ext = path.extname(file).toLowerCase();
        if (ext === '.bat' || ext === '.cmd') return [file, extraArgs];
        if (ext === '.ps1') return ['powershell', ['-ExecutionPolicy', 'Bypass', '-File', file].concat(extraArgs)];
        return ['bash', [file].concat(extraArgs)];
    }
    if (lang === 'powershell') return ['powershell', ['-ExecutionPolicy', 'Bypass', '-File', file].concat(extraArgs)];
    return null;
}

function tail(s, n) {
    const t = String(s || '');
    return t.length > n ? '...(截断)...\n' + t.slice(-n) : t;
}

module.exports = {
    name: 'run_script',
    description: "运行工作区脚本（js/py/sh/bat/ps1），返回退出码与输出",
    params: [
        { k: "path", cn: "脚本路径", req: true, d: "" },
        { k: "args", cn: "参数", req: false, d: "空格分隔" },
        { k: "lang", cn: "语言", req: false, d: "node / python / shell / powershell，默认按扩展名" },
        { k: "stdin", cn: "标准输入", req: false, d: "" },
        { k: "cwd", cn: "工作目录", req: false, d: "默认脚本所在目录" },
        { k: "timeout", cn: "超时", req: false, d: "毫秒，默认 60000" },
        { k: "tailChars", cn: "输出尾部字符", req: false, d: "默认 4000" },
        { k: "env", cn: "环境变量", req: false, d: "JSON，追加" }
    ],
    execute: async (args) => {
        const p = V(args, 'path') || V(args, 'file');
        if (!p) return '错误：缺少 path';
        const abs = await resolveWsPath(p);
        if (!fs.existsSync(abs)) return '错误：脚本不存在 ' + p;
        if (fs.statSync(abs).isDirectory()) return '错误：path 是目录，不是脚本';

        const lang = pickLang(abs, V(args, 'lang'));
        if (!lang) return '错误：无法推断脚本类型，请通过 lang 指定 node / python / shell / powershell';

        // args 与内置参数同名易被解析器吞掉，做多路兜底
        let argsStr = V(args, 'args') || V(args, 'argv') || V(args, 'cmdargs') || V(args, 'scriptArgs');
        if (!argsStr && args && args.extraArgs) {
            const ex = args.extraArgs;
            argsStr = V(ex, 'args') || V(ex, 'argv') || '';
            if (!argsStr && ex.toolcall) {
                const m = String(ex.toolcall).match(/<args>([\s\S]*?)<\/args>/);
                if (m) argsStr = m[1].trim();
            }
        }
        const extraArgs = argsStr ? argsStr.match(/(?:[^\s"]+|"[^"]*")+/g).map(s => s.replace(/^"|"$/g, '')) : [];
        const cmd = buildCmd(lang, abs, extraArgs);
        if (!cmd) return '错误：不支持的脚本类型 ' + lang + ' / ' + path.extname(abs);

        const cwdArg = V(args, 'cwd');
        const cwd = cwdArg ? await resolveWsPath(cwdArg) : path.dirname(abs);
        const timeout = Math.min(Math.max(parseInt(V(args, 'timeout') || '60000', 10) || 60000, 500), 600000);
        const tailChars = Math.min(Math.max(parseInt(V(args, 'tailChars') || '4000', 10) || 4000, 200), 20000);

        let env = Object.assign({}, process.env);
        const envRaw = V(args, 'env');
        if (envRaw) {
            try { Object.assign(env, JSON.parse(envRaw)); } catch (e) { return '错误：env 不是合法 JSON - ' + e.message; }
        }

        const stdin = V(args, 'stdin');
        const t0 = Date.now();
        const r = spawnSync(cmd[0], cmd[1], {
            cwd, timeout, encoding: 'utf8', env, maxBuffer: 30 * 1024 * 1024,
            input: stdin || undefined
        });
        const cost = Date.now() - t0;

        if (r.error && r.error.code === 'ENOENT') {
            return '启动失败：找不到解释器 ' + cmd[0] + '，本机可能未安装（lang=' + lang + '）';
        }
        if (r.error && r.error.code === 'ETIMEDOUT') {
            return '脚本执行超时（' + timeout + 'ms）\n命令: ' + cmd[0] + ' ' + cmd[1].join(' ') + '\n' + tail((r.stdout || '') + '\n' + (r.stderr || ''), tailChars);
        }

        const code = r.status == null ? -1 : r.status;
        const lines = [];
        lines.push('脚本: ' + p + '  [' + lang + ']');
        lines.push('命令: ' + cmd[0] + ' ' + cmd[1].map(a => a.includes(' ') ? JSON.stringify(a) : a).join(' '));
        lines.push('退出码: ' + code + (code === 0 ? ' ✅' : ' ❌') + '  耗时 ' + cost + 'ms');
        if (r.signal) lines.push('信号: ' + r.signal);
        if (r.stdout) lines.push('--- stdout ---\n' + tail(r.stdout.trim(), tailChars));
        if (r.stderr) lines.push('--- stderr ---\n' + tail(r.stderr.trim(), tailChars));
        return lines.join('\n');
    }
};
