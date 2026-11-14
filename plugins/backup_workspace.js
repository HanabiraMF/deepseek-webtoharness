
const fs = require('fs');
const path = require('path');
const { getWorkspace, resolveWsPath, V } = require('./_workspace');

const SKIP_DIRS = new Set([
    '.git', 'node_modules', '.ds_snapshots', '.ds_backups', '.ds_test',
    'dist', 'build', '__pycache__', '.venv', 'venv', 'target', '.next', 'out',
]);
const SKIP_EXTS = new Set([
    '.zip', '.mp4', '.mp3', '.wav', '.exe', '.dll', '.so', '.dylib', '.bin',
    '.7z', '.gz', '.tar', '.pyc', '.pdb', '.cache',
]);

function pad(n, w) { n = String(n); return n.length >= w ? n : '0'.repeat(w - n.length) + n; }
function stamp() {
    const d = new Date();
    return d.getFullYear() + pad(d.getMonth() + 1, 2) + pad(d.getDate(), 2) + '_' +
        pad(d.getHours(), 2) + pad(d.getMinutes(), 2) + pad(d.getSeconds(), 2);
}
function fmtSize(b) {
    if (b < 1024) return b + 'B';
    if (b < 1048576) return (b / 1024).toFixed(1) + 'K';
    return (b / 1048576).toFixed(1) + 'M';
}

module.exports = {
    name: 'backup_workspace',
    description: "备份工作区到带时间戳的目录",
    params: [
        { k: "dest", cn: "备份目录", req: false, d: "默认 .ds_backups/backup_时间戳" },
        { k: "path", cn: "子目录", req: false, d: "只备份指定子目录" },
        { k: "skip", cn: "跳过目录", req: false, d: "逗号分隔" },
        { k: "include", cn: "仅含扩展名", req: false, d: "如 .js,.html" },
        { k: "keepBaks", cn: "保留 bak", req: false, d: "true 时保留 .bak 文件" }
    ],
    execute: async (args) => {
        const ws = await getWorkspace();
        const src = args && V(args, 'path') ? await resolveWsPath(V(args, 'path')) : ws;
        if (!fs.existsSync(src)) throw new Error('源路径不存在: ' + src);
        if (!fs.statSync(src).isDirectory()) throw new Error('源路径不是目录: ' + src);

        const destArg = V(args, 'dest');
        const destRoot = destArg ? await resolveWsPath(destArg) : path.join(ws, '.ds_backups', 'backup_' + stamp());
        if (path.resolve(destRoot) === path.resolve(src)) throw new Error('备份目标不能等于源目录');

        const extraSkip = String(V(args, 'skip') || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
        const includeExts = String(V(args, 'include') || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
        const keepBaks = /^(true|1|yes)$/i.test(V(args, 'keepBaks'));

        let files = 0, bytes = 0, skippedDirs = 0, skippedExt = 0, skippedBak = 0;
        const errors = [];
        fs.mkdirSync(destRoot, { recursive: true });

        (function walk(dir) {
            let names;
            try { names = fs.readdirSync(dir); } catch (e) { errors.push(dir + ': ' + e.message); return; }
            for (const name of names) {
                const full = path.join(dir, name);
                const rel = path.relative(src, full);
                // 防自包含：跳过落在目标目录里的内容
                if (path.resolve(full) === path.resolve(destRoot) || path.resolve(destRoot).startsWith(path.resolve(full) + path.sep)) {
                    skippedDirs++; continue;
                }
                let st;
                try { st = fs.statSync(full); } catch (e) { errors.push(full + ': ' + e.message); continue; }
                const lower = name.toLowerCase();
                if (st.isDirectory()) {
                    if (SKIP_DIRS.has(lower) || extraSkip.includes(lower)) { skippedDirs++; continue; }
                    try { fs.mkdirSync(path.join(destRoot, rel), { recursive: true }); } catch (e) { errors.push(rel + ': ' + e.message); continue; }
                    walk(full);
                } else {
                    const ext = path.extname(lower);
                    if (includeExts.length && !includeExts.includes(ext)) { skippedExt++; continue; }
                    if (!includeExts.length && SKIP_EXTS.has(ext)) { skippedExt++; continue; }
                    if (!keepBaks && /\.bak$/.test(lower)) { skippedBak++; continue; }
                    try {
                        const target = path.join(destRoot, rel);
                        fs.mkdirSync(path.dirname(target), { recursive: true });
                        fs.copyFileSync(full, target);
                        files++; bytes += st.size;
                    } catch (e) { errors.push(rel + ': ' + e.message); }
                }
            }
        })(src);

        const lines = [
            '备份完成：' + destRoot,
            '  源目录: ' + src,
            '  复制文件: ' + files + ' 个，共 ' + fmtSize(bytes),
            '  跳过目录: ' + skippedDirs + ' 个，跳过扩展名: ' + skippedExt + ' 个，跳过 .bak: ' + skippedBak + ' 个',
        ];
        if (errors.length) lines.push('  错误 ' + errors.length + ' 条：\n' + errors.slice(0, 10).map(e => '    - ' + e).join('\n'));
        return lines.join('\n');
    },
};
