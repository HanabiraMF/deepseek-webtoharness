const { exec } = require('child_process');

module.exports = {
    name: 'wifi_info',
    description: '获取本机 Wi-Fi 信息。参数：action(list 列出保存的 Wi-Fi 及密码 / current 查看当前连接的 Wi-Fi)。',
    execute: async (args) => {
        const action = (args.action || args.extraArgs?.action || 'current').toLowerCase();
        return new Promise((resolve) => {
            if (action === 'current') {
                exec('netsh wlan show interfaces', { timeout: 5000, windowsHide: true }, (err, stdout) => {
                    if (err) return resolve('获取失败: ' + err.message);
                    resolve(stdout.trim());
                });
            } else {
                // 先获取所有配置文件名
                exec('netsh wlan show profiles', { timeout: 5000, windowsHide: true }, (err, stdout) => {
                    if (err) return resolve('获取列表失败: ' + err.message);
                    const profiles = [];
                    const re = /All User Profile\s*:\s*(.+)/gi;
                    let m;
                    while ((m = re.exec(stdout)) !== null) profiles.push(m[1].trim());
                    
                    if (profiles.length === 0) return resolve('未发现保存的 Wi-Fi。');
                    
                    let out = '=== 保存的 Wi-Fi 列表 ===\n';
                    let pending = profiles.length;
                    profiles.forEach(name => {
                        exec(`netsh wlan show profile name="${name}" key=clear`, { timeout: 5000, windowsHide: true }, (e2, stdout2) => {
                            let pwd = '无密码/未存储';
                            const pM = stdout2.match(/Key Content\s*:\s*(.+)/i);
                            if (pM) pwd = pM[1].trim();
                            out += `- ${name}  |  密码: ${pwd}\n`;
                            if (--pending === 0) resolve(out.trim());
                        });
                    });
                });
            }
        });
    }
};
