const { exec } = require('child_process');

const V = (a, k) => {
    if (!a) return '';
    if (a[k] != null && a[k] !== '') return String(a[k]);
    const ex = a.extraArgs || {};
    if (ex[k] != null && ex[k] !== '') return String(ex[k]);
    const lower = k.toLowerCase();
    for (const key of Object.keys(ex)) { if (key.toLowerCase() === lower && ex[key] != null) return String(ex[key]); }
    return '';
};

module.exports = {
    name: 'git_helper',
    description: '在工作区执行 Git 命令。参数：command(如 "status", "log --oneline -5", "diff HEAD")。出于安全已屏蔽 reset --hard / clean -fd / push --force。',
    execute: async (args) => {
        const cmd = V(args, 'command').trim();
        if (!cmd) return '错误：缺少 command';
        if (/reset\s+--hard|clean\s+-[a-z]*f|push\s+--force|push\s+-f\b/i.test(cmd)) {
            return '错误：出于安全原因，禁止执行 reset --hard / clean -fd / push --force。请手动执行。';
        }
        return new Promise((resolve) => {
            // 切到 UTF-8 代码页，防止 git 输出的中文路径或提交信息乱码
            exec(`chcp 65001 >nul & git ${cmd}`, { cwd: process.cwd(), timeout: 20000, windowsHide: true }, (err, stdout, stderr) => {
                let res = '';
                if (stdout) res += stdout;
                if (stderr) res += (res ? '\n' : '') + stderr;
                if (err && !res) res = err.message;
                resolve(String(res).trim() || '(无输出)');
            });
        });
    }
};
