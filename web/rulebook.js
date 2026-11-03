// 规则书阅读器：逐页显示预先渲染好的页面图片（按需加载），并可下载原版 PDF
const $ = (s) => document.querySelector(s);
let pages = null, observer = null, current = 1;

function goto(n) {
  const box = document.querySelector(`.bpage[data-n="${Math.max(1, Math.min(pages.length, n))}"]`);
  box?.scrollIntoView({ block: 'start' });
}

async function openBook(pdfUrl, toast) {
  $('#book').hidden = false;
  if (pages) return;
  try {
    pages = await (await fetch('book/pages.json')).json();
  } catch {
    $('#bookMsg').textContent = '规则书暂时打不开，请稍后再试。';
    return;
  }
  const root = $('#bookPages');
  root.replaceChildren();
  pages.forEach((p, i) => {
    const box = document.createElement('div');
    box.className = 'bpage'; box.dataset.n = i + 1;
    box.style.aspectRatio = `${p.w} / ${p.h}`;
    if (p.w > p.h) box.style.width = 'min(1200px, 100%)';
    const img = document.createElement('img');
    img.loading = 'lazy'; img.decoding = 'async'; img.alt = `第 ${i + 1} 页`;
    img.src = p.src; img.style.cssText = 'display:block;width:100%;height:auto';
    box.append(img); root.append(box);
  });
  observer = new IntersectionObserver((ents) => {
    for (const en of ents) if (en.isIntersecting) { current = +en.target.dataset.n; $('#bookPage').textContent = `${current} / ${pages.length}`; }
  }, { root, threshold: 0.35 });
  document.querySelectorAll('.bpage').forEach((b) => observer.observe(b));
  $('#bookPage').textContent = `1 / ${pages.length}`;

  let dl = null;
  try { dl = window.claude?.use ? await window.claude.use('downloads') : null; } catch { dl = null; }
  if (dl && pdfUrl) {
    $('#bookSave').hidden = false;
    $('#bookSave').onclick = async () => {
      const btn = $('#bookSave');
      btn.disabled = true; btn.textContent = '准备文件…';
      try {
        const blob = await (await fetch(pdfUrl)).blob();
        await dl.save({ filename: '突出部之矛-阿登1944-规则书-最终修订版.pdf', data: blob });
      } catch (e) {
        if (e?.code !== 'declined') toast?.('暂时无法下载：' + (e?.code || e?.message || '未知原因'));
      }
      btn.disabled = false; btn.textContent = '下载 PDF';
    };
  }
}

export function initBook(toast) {
  $('#bookClose').onclick = () => { $('#book').hidden = true; };
  $('#bookPrev').onclick = () => pages && goto(current - 1);
  $('#bookNext').onclick = () => pages && goto(current + 1);
  addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('#book').hidden) $('#book').hidden = true; });
  $('#bookBtn').onclick = () => openBook($('#bookBtn').dataset.pdf, toast);
}
