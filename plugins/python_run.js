const fs = require('fs');
const path = require('path');
const os = require('os');
const { exec } = require('child_process');

// 插件参数兼容读取：顶层字段 或 extraArgs（自定义标签会落在 extraArgs）
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
    name: 'python_run',
    description: '直接运行 Python 代码或脚本。参数：code(直接执行的代码字符串) 或 path(工作区内的.py脚本路径)，可选 args(命令行参数)。',
    execute: async (args) => {
        const code = V(args, 'code');
        let filePath = V(args, 'path');
        const extraArgs = V(args, 'args');
        let tmpFile = null;

        if (code) {
            tmpFile = path.join(os.tmpdir(), 'ds_py_' + Date.now() + '_' + Math.floor(Math.random() * 1000) + '.py');
            fs.writeFileSync(tmpFile, code, 'utf8');
            filePath = tmpFile;
        }
        if (!filePath) return '错误：请提供 code 或 path';

        const run = (cmd) => new Promise((resolve) => {
            exec(`${cmd} "${filePath}" ${extraArgs}`, { 
                timeout: 30000, 
                windowsHide: true,
                env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' }
            }, (err, stdout, stderr) => {
                if (err && (err.code === 'ENOENT' || /not recognized|不是内部或外部命令/i.test(String(err.message)))) {
                    if (cmd === 'python') return resolve(run('python3'));
                    return resolve('错误：未找到 python / python3，请确认已安装并加入 PATH。');
                }
                if (tmpFile) { try { fs.unlinkSync(tmpFile); } catch (e) {} }
                let res = '';
                if (stdout) res += stdout;
                if (stderr) res += (res ? '\n--- stderr ---\n' : '') + stderr;
                if (err && !res) res = '退出码 ' + err.code + ': ' + err.message;
                resolve(String(res).trim() || '(无输出)');
            });
        });
        return run('python');
    }
};
