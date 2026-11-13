// ===== 通用交互逻辑 =====

// 复制到剪贴板
function copyText(text, btn) {
  const done = () => {
    if (!btn) return;
    const orig = btn.innerHTML;
    btn.innerHTML = (window.ICONS.check || '') + ' 已复制';
    setTimeout(() => { btn.innerHTML = orig; }, 1800);
  };
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(done).catch(() => fallbackCopy(text, done));
  } else {
    fallbackCopy(text, done);
  }
}
function fallbackCopy(text, cb) {
  const ta = document.createElement('textarea');
  ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
  document.body.appendChild(ta); ta.select();
  try { document.execCommand('copy'); cb && cb(); } catch (e) {}
  document.body.removeChild(ta);
}

// FAQ 手风琴
function initFaq() {
  document.querySelectorAll('.faq-item').forEach(item => {
    const q = item.querySelector('.faq-q');
    if (!q) return;
    q.addEventListener('click', () => item.classList.toggle('open'));
  });
}

// 注入图标占位
function injectIcons() {
  document.querySelectorAll('[data-icon]').forEach(el => {
    const name = el.getAttribute('data-icon');
    if (window.ICONS && window.ICONS[name]) el.innerHTML = window.ICONS[name];
  });
}

document.addEventListener('DOMContentLoaded', () => {
  injectIcons();
  initFaq();
});
