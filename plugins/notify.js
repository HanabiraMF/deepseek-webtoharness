const { exec } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

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
    name: 'notify',
    description: "弹出系统桌面通知",
    params: [
        { k: "title", cn: "标题", req: true, d: "" },
        { k: "message", cn: "内容", req: true, d: "" }
    ],
    execute: async (args) => {
        const title = (V(args, 'title') || 'DeepSeek 本地智能体').replace(/["'`]/g, ' ');
        const msg = (V(args, 'message') || '任务完成').replace(/["'`]/g, ' ');
        const ps = `
            [Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
            $template = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02)
            $textNodes = $template.GetElementsByTagName('text')
            $textNodes.Item(0).AppendChild($template.CreateTextNode('${title}')) | Out-Null
            $textNodes.Item(1).AppendChild($template.CreateTextNode('${msg}')) | Out-Null
            $toast = [Windows.UI.Notifications.ToastNotification]::new($template)
            [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('DeepSeek Agent').Show($toast)
        `;
        const tmpFile = path.join(os.tmpdir(), 'ds_notify_' + Date.now() + '.ps1');
        
        try {
            // 写入 BOM 防乱码
            fs.writeFileSync(tmpFile, '\uFEFF' + ps, 'utf8');
        } catch (e) {
            return '创建临时脚本失败: ' + e.message;
        }

        return new Promise((resolve) => {
            exec(`powershell -NoProfile -ExecutionPolicy Bypass -File "${tmpFile}"`, { timeout: 8000, windowsHide: true }, (err, stdout, stderr) => {
                try { fs.unlinkSync(tmpFile); } catch (e) {}
                if (err) {
                    return resolve('通知发送失败: ' + (stderr || err.message));
                }
                resolve('已发送系统通知：' + title + ' - ' + msg);
            });
        });
    }
};
