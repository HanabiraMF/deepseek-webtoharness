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
    name: 'process_mgr',
    description: "系统进程管理：查看、搜索、结束进程",
    params: [
        { k: "action", cn: "操作", req: true, d: "list / find / kill" },
        { k: "name", cn: "进程名", req: false, d: "用于 find，如 node.exe" },
        { k: "pid", cn: "进程 ID", req: false, d: "用于 kill" }
    ],
    execute: async (args) => {
        const action = V(args, 'action');
        const name = V(args, 'name');
        const pid = V(args, 'pid');
        
        return new Promise((resolve) => {
            let cmd = '';
            if (action === 'list') {
                cmd = 'tasklist /FO CSV /NH';
            } else if (action === 'find' && name) {
                cmd = `tasklist /FI "IMAGENAME eq ${name}" /FO CSV /NH`;
            } else if (action === 'kill' && pid) {
                cmd = `taskkill /F /PID ${pid}`;
            } else {
                return resolve('错误：缺少参数。list 无参数，find 需 name，kill 需 pid');
            }
            
            exec(cmd, { timeout: 10000, windowsHide: true }, (err, stdout, stderr) => {
                let out = String(stdout || '').trim();
                if (action === 'list' && out) {
                    const lines = out.split('\n');
                    if (lines.length > 30) out = lines.slice(0, 30).join('\n') + '\n... (已截断)';
                }
                if (err && !out) return resolve('执行失败: ' + err.message);
                resolve(out || '(无结果)');
            });
        });
    }
};
