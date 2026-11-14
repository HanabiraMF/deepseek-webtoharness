const fs = require('fs');
const path = require('path');

const WORKSPACE = process.cwd();
const SKIP_DIRS = new Set(['.git', 'node_modules', 'dist', 'build', '.ds_backups', '.ds_snapshots', 'venv', '.venv', '__pycache__', 'target', '.next', 'out']);
const TEXT_EXT = new Set(['.js', '.json', '.ts', '.jsx', '.tsx', '.html', '.htm', '.css', '.md', '.txt', '.py', '.sh', '.bat', '.ps1', '.yml', '.yaml', '.xml', '.svg', '.java', '.c', '.cpp', '.h', '.go', '.rs', '.php', '.rb', '.ini', '.conf', '.log']);

function listFiles(abs, out, max) {
    if (out.length >= max) return;
    let st;
    try { st = fs.statSync(abs); } catch { return; }
    if (st.isDirectory()) {
        const base = path.basename(abs).toLowerCase();
        if (SKIP_DIRS.has(base)) return;
        let names;
        try { names = fs.readdirSync(abs); } catch { return; }
        for (const n of names) {
            listFiles(path.join(abs, n), out, max);
            if (out.length >= max) return;
        }
    } else if (st.isFile()) {
        const ext = path.extname(abs).toLowerCase();
        if (!ext || TEXT_EXT.has(ext)) out.push(abs);
    }
}

module.exports = {
    name: 'mojibake_scan',
    description: '扫描文本文件中的乱码字符（默认 U+FFFD 替换符），返回文件名、行号与内容。可指定文件或递归目录。',
    params: [
        { k: 'path', cn: '目标路径', req: false, d: '文件或目录（相对工作区），默认整个工作区' },
        { k: 'char', cn: '乱码码位', req: false, d: '十六进制码位，默认 FFFD（即 U+FFFD 替换符）' },
        { k: 'ext', cn: '扩展名过滤', req: false, d: '如 .js,.md，仅用于目录扫描' },
        { k: 'limit', cn: '命中上限', req: false, d: '默认 200' },
        { k: 'maxFiles', cn: '扫描文件上限', req: false, d: '目录模式最多扫描多少文件，默认 5000' },
    ],
    execute: async (args) => {
        args = args || {};
        const rawPath = String(args.path || '.').trim();
        const code = parseInt(String(args.char || 'FFFD').replace(/^0x/i, ''), 16);
        if (!Number.isFinite(code) || code < 0 || code > 0x10FFFF) throw new Error('char 参数无效，应为十六进制码位，如 FFFD');
        const target = String.fromCodePoint(code);
        const limit = Math.max(1, Math.min(2000, parseInt(args.limit, 10) || 200));
        const maxFiles = Math.max(1, Math.min(50000, parseInt(args.maxFiles, 10) || 5000));
        const extFilter = args.ext
            ? new Set(String(args.ext).split(',').map(s => s.trim().toLowerCase()).filter(Boolean).map(s => s.startsWith('.') ? s : '.' + s))
            : null;

        const absTarget = path.resolve(WORKSPACE, rawPath);
        const rel = path.relative(WORKSPACE, absTarget);
        if (rel.startsWith('..') || path.isAbsolute(rel)) throw new Error('路径越界：只能扫描工作区内的文件');
        if (!fs.existsSync(absTarget)) throw new Error('路径不存在: ' + rawPath);

        const files = [];
        const st = fs.statSync(absTarget);
        if (st.isDirectory()) {
            listFiles(absTarget, files, maxFiles);
            if (extFilter) {
                for (let i = files.length - 1; i >= 0; i--) {
                    if (!extFilter.has(path.extname(files[i]).toLowerCase())) files.splice(i, 1);
                }
            }
        } else {
            files.push(absTarget);
        }

        const hits = [];
        let scanned = 0, unreadable = 0;
        for (const f of files) {
            let text;
            try { text = fs.readFileSync(f, 'utf8'); } catch { unreadable++; continue; }
            scanned++;
            if (!text.includes(target)) continue;
            const lines = text.split('\n');
            for (let i = 0; i < lines.length; i++) {
                const ln = lines[i];
                if (!ln.includes(target)) continue;
                const col = ln.indexOf(target);
                let cnt = 0, idx = 0;
                while ((idx = ln.indexOf(target, idx)) !== -1) { cnt++; idx += target.length; }
                hits.push({
                    file: path.relative(WORKSPACE, f),
                    line: i + 1,
                    count: cnt,
                    col: col + 1,
                    text: ln.trim().slice(0, 160),
                });
                if (hits.length >= limit) break;
            }
            if (hits.length >= limit) break;
        }

        const cpLabel = 'U+' + code.toString(16).toUpperCase().padStart(4, '0') + (code === 0xFFFD ? ' (替换符)' : '');
        if (!hits.length) {
            return `✅ 未发现乱码字符 ${cpLabel}\n扫描 ${scanned} 个文件${unreadable ? `（${unreadable} 个读取失败）` : ''}，路径: ${path.relative(WORKSPACE, absTarget) || '.'}`;
        }

        let out = `⚠️ 发现 ${hits.length}${hits.length >= limit ? '+' : ''} 行含乱码字符 ${cpLabel}\n扫描 ${scanned} 个文件，路径: ${path.relative(WORKSPACE, absTarget) || '.'}\n\n`;
        for (const h of hits) {
            out += `${h.file}:${h.line}  [${h.count}个, 列${h.col}]\n  ${h.text}\n`;
        }
        if (hits.length >= limit) out += `\n（已达上限 ${limit}，可能还有更多）`;
        return out;
    },
};
