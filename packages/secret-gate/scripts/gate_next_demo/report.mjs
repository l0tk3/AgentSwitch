/** Render an offline report. Inputs are data; no report values enter executable JS. */
const escape = (value) => String(value ?? '').replace(/[&<>"']/g, (character) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[character]));

function localAsset(value) {
  if (typeof value !== 'string' || !value || !/^[a-zA-Z0-9_][a-zA-Z0-9_./ -]*$/.test(value)) return null;
  if (value.split('/').some((part) => part === '..' || part === '.' || !part)) return null;
  return value;
}

function valueText(value) {
  if (typeof value === 'object' && value !== null) return JSON.stringify(value, null, 2);
  return String(value ?? '—');
}

function renderArtifacts(artifacts, index) {
  if (!artifacts) return '';
  const before = localAsset(artifacts.before);
  const after = localAsset(artifacts.after);
  const snapshot = localAsset(artifacts.snapshot);
  const beforeLabel = artifacts.beforeLabel || '遮罩前';
  const afterLabel = artifacts.afterLabel || '遮罩后';
  const figures = [before && `<figure class="before"><img src="${escape(before)}" alt="实验 ${index + 1}：${escape(beforeLabel)}，全部为虚构数据" loading="lazy"><figcaption><span class="image-dot original"></span>${escape(beforeLabel)} · 虚构数据</figcaption></figure>`,
    after && `<figure class="after"><img src="${escape(after)}" alt="实验 ${index + 1}：${escape(afterLabel)}，全部为虚构数据" loading="lazy"><figcaption><span class="image-dot"></span>${escape(afterLabel)}</figcaption></figure>`].filter(Boolean).join('');
  if (!figures && !snapshot) return '';
  return `<section class="artifacts" aria-label="实验产物" data-mode="compare">
    <div class="artifact-toolbar"><h3>观察结果</h3>${before && after ? `<div class="view-switch" role="group" aria-label="图片查看方式">
      <button type="button" data-view="compare" aria-pressed="true">并排</button><button type="button" data-view="before" aria-pressed="false">${escape(beforeLabel)}</button><button type="button" data-view="after" aria-pressed="false">${escape(afterLabel)}</button>
    </div>` : ''}</div>
    ${figures ? `<div class="image-grid">${figures}</div>` : ''}
    ${snapshot ? `<a class="artifact-link" href="${escape(snapshot)}">查看模拟模型快照 <span aria-hidden="true">↗</span></a>` : ''}
  </section>`;
}

function renderDemo(demo, index) {
  const checks = Array.isArray(demo.checks) ? demo.checks : [];
  const passed = checks.filter((check) => check.passed === true).length;
  const failed = checks.length - passed;
  const metrics = Object.entries(demo.metrics ?? {});
  const limitations = Array.isArray(demo.limitations) ? demo.limitations : [];
  return `<article class="demo">
    <div class="demo-heading"><span class="demo-number">${String(index + 1).padStart(2, '0')}</span><div class="demo-title"><h2>${escape(demo.name)}</h2>${demo.description ? `<p>${escape(demo.description)}</p>` : ''}</div><span class="badge ${failed ? 'failed' : checks.length ? 'passed' : 'neutral'}">${failed ? `${failed} 项未通过` : checks.length ? '检查通过' : '未记录检查'}</span></div>
    ${metrics.length ? `<dl class="metrics">${metrics.map(([key, value]) => `<div><dt>${escape(key)}</dt><dd>${escape(valueText(value))}</dd></div>`).join('')}</dl>` : ''}
    <details class="checks"${failed ? ' open' : ''}><summary><span>验证明细 <span class="check-count">${passed} / ${checks.length} 通过</span></span><span class="expand-icon" aria-hidden="true">+</span></summary>
      <ul>${checks.length ? checks.map((check) => `<li class="${check.passed === true ? 'check-pass' : 'check-fail'}"><span class="check-icon" aria-label="${check.passed === true ? '通过' : '未通过'}">${check.passed === true ? '✓' : '!'}</span><div><strong>${escape(check.name)}</strong>${check.detail == null ? '' : `<p>${escape(valueText(check.detail))}</p>`}</div></li>`).join('') : '<li class="empty-checks">本项没有记录检查结果。</li>'}</ul>
    </details>
    ${renderArtifacts(demo.artifacts, index)}
    ${limitations.length ? `<aside class="demo-limits"><h3>本项边界</h3><ul>${limitations.map((item) => `<li>${escape(item)}</li>`).join('')}</ul></aside>` : ''}
  </article>`;
}

export function renderReport(report) {
  const demos = Array.isArray(report.demos) ? report.demos : [];
  const checks = demos.flatMap((demo) => Array.isArray(demo.checks) ? demo.checks : []);
  const passed = checks.filter((check) => check.passed === true).length;
  const failed = checks.length - passed;
  const limits = Array.isArray(report.limitations) ? report.limitations : [];
  const title = report.title || '凭据层 · 隔离实验';
  const environment = Object.entries(report.environment ?? {});
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light"><title>${escape(title)}</title>
<style>
:root{font-family:ui-sans-serif,-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;color:#192d2b;background:#f2f5f1;font-synthesis:none;--muted:#64736d;--line:#dce4dd;--green:#236a53;--mono:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}*{box-sizing:border-box}body{margin:0;line-height:1.6}button,a{-webkit-tap-highlight-color:transparent}button{font:inherit}a{color:var(--green)}a:focus-visible,button:focus-visible,summary:focus-visible{outline:3px solid #7ec1a5;outline-offset:4px}.shell{max-width:1180px;margin:auto;padding:44px 32px 36px}.masthead{display:flex;align-items:center;justify-content:space-between;gap:20px;padding-bottom:27px;border-bottom:1px solid var(--line)}.brand{font-weight:750;letter-spacing:-.4px;font-size:19px;display:flex;align-items:center;gap:10px}.brand-mark{width:25px;height:25px;border-radius:7px;background:var(--green);color:white;display:grid;place-items:center;font-size:15px}.edition{font-size:12px;color:var(--muted);letter-spacing:.08em}.intro{display:grid;grid-template-columns:1fr auto;gap:28px;padding:38px 0 27px;align-items:end}.eyebrow{font-size:12px;color:var(--green);font-weight:750;letter-spacing:.16em;margin:0 0 11px}h1{font-size:clamp(28px,4vw,42px);line-height:1.22;letter-spacing:-1.2px;font-weight:720;margin:0 0 15px}.subtitle{font-size:15px;color:var(--muted);max-width:640px;margin:0}.summary-grid{display:flex;gap:29px;padding:0 3px 4px 15px}.stat{min-width:55px}.stat strong{display:block;font-size:34px;font-weight:650;line-height:1.1;font-variant-numeric:tabular-nums;letter-spacing:-1px}.stat span{font-size:12px;color:var(--muted);white-space:nowrap}.stat.success strong{color:var(--green)}.stat.failure strong{color:#a63f37}.notice{border:1px solid #d5e3d8;background:#e9f0e8;padding:13px 17px;border-radius:10px;display:flex;align-items:baseline;gap:16px;font-size:13px;color:#4d6257}.notice strong{flex-shrink:0;color:#2c5443;font-weight:650}.environment{display:flex;flex-wrap:wrap;gap:9px 18px;margin:16px 1px 31px;font-family:var(--mono);font-size:11px;color:var(--muted)}.environment span{overflow-wrap:anywhere}.environment b{font-weight:500;color:#30473c}.demos{display:grid;gap:21px}.demo{background:#fff;border:1px solid var(--line);border-radius:16px;overflow:hidden;box-shadow:0 2px 5px #24392b03}.demo-heading{display:flex;align-items:flex-start;gap:16px;padding:26px 27px 22px}.demo-number{font-family:var(--mono);font-size:14px;color:#527063;border:1px solid #dde7df;background:#f5f8f4;border-radius:9px;display:grid;place-items:center;width:37px;height:37px;flex-shrink:0;margin-top:1px}.demo-title{flex:1;min-width:0}.demo-title h2{font-size:19px;line-height:1.4;letter-spacing:-.2px;margin:0 0 6px;font-weight:680;overflow-wrap:anywhere}.demo-title p{font-size:13px;color:var(--muted);margin:0;max-width:800px;overflow-wrap:anywhere}.badge{font-size:11px;font-weight:650;border-radius:6px;padding:4px 9px;white-space:nowrap;margin-top:3px}.passed{background:#e9f3ec;color:#226343}.failed{background:#fae9e4;color:#a24032}.neutral{background:#eef0ed;color:#64736d}.metrics{margin:0 27px 20px 80px;display:flex;gap:18px 34px;flex-wrap:wrap}.metrics div{min-width:70px;max-width:100%}.metrics dt{color:var(--muted);font-size:11px;margin-bottom:2px;overflow-wrap:anywhere}.metrics dd{margin:0;font-size:14px;font-family:var(--mono);color:#315145;white-space:pre-wrap;overflow-wrap:anywhere}.checks{border-top:1px solid #edf0eb}.checks summary{padding:15px 27px;cursor:pointer;display:flex;justify-content:space-between;align-items:center;list-style:none;font-size:13px;font-weight:620;user-select:none}.checks summary::-webkit-details-marker{display:none}.checks summary:hover{background:#fafbf8}.check-count{color:var(--muted);font-family:var(--mono);font-size:11px;font-weight:400;margin-left:12px}.expand-icon{font-size:20px;color:#6f8276;line-height:1;transition:transform .15s}.checks[open] .expand-icon{transform:rotate(45deg)}.checks ul{list-style:none;margin:0;padding:0 27px 18px;display:grid;grid-template-columns:1fr 1fr;gap:15px 24px}.checks li{display:flex;align-items:flex-start;gap:10px;font-size:12px;min-width:0}.check-icon{border-radius:50%;width:18px;height:18px;line-height:18px;text-align:center;flex-shrink:0;font-size:11px;margin-top:1px;background:#e8f3ec;color:#236447}.check-fail .check-icon{background:#f8e5e0;color:#b44733}.checks li strong{font-size:12px;font-weight:580;overflow-wrap:anywhere}.checks li p{font-size:11px;color:var(--muted);margin:3px 0 0;white-space:pre-wrap;overflow-wrap:anywhere}.checks .empty-checks{color:var(--muted)}.artifacts{padding:20px 27px 23px;border-top:1px solid #edf0eb;background:#fcfdfb}.artifact-toolbar{display:flex;justify-content:space-between;gap:16px;align-items:center;margin-bottom:15px}h3{font-size:12px;letter-spacing:.02em;margin:0;font-weight:650}.view-switch{display:flex;border:1px solid #dfe5de;border-radius:8px;padding:3px;background:#f1f4ef;gap:2px}.view-switch button{border:0;background:transparent;color:#64736d;padding:4px 12px;border-radius:5px;font-size:11px;cursor:pointer}.view-switch button[aria-pressed=true]{background:white;color:#284d3e;box-shadow:0 1px 3px #20382b13}.image-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:15px}.image-grid figure{margin:0;min-width:0}.image-grid img{width:100%;height:auto;display:block;border:1px solid #dee5df;border-radius:9px;background:#edf2ed}.image-grid figcaption{display:flex;align-items:center;justify-content:center;gap:6px;font-size:11px;color:var(--muted);margin-top:9px}.image-dot{width:5px;height:5px;border-radius:50%;background:#4c9272}.image-dot.original{background:#c4a265}.artifacts[data-mode=before] .after,.artifacts[data-mode=after] .before{display:none}.artifacts[data-mode=before] .image-grid,.artifacts[data-mode=after] .image-grid,.image-grid:has(figure:only-child){grid-template-columns:minmax(0,1fr)}.artifact-link{display:inline-flex;gap:9px;align-items:center;font-size:12px;text-decoration:none;margin-top:14px;border-bottom:1px solid #a9c8b6;padding-bottom:1px}.artifact-link:hover{color:#0c4f32}.demo-limits{border-top:1px solid #edf0eb;padding:15px 27px 17px;background:#fafbf8;color:#667168}.demo-limits h3{color:#43554b}.demo-limits ul,.boundaries ul{padding-left:17px;margin:7px 0 0;font-size:12px}.demo-limits li,.boundaries li{padding-left:2px;margin:4px 0;overflow-wrap:anywhere}.boundaries{margin-top:31px;padding:20px 23px;border:1px solid #d9e2d8;border-radius:12px;color:#5e6d63}.boundaries h2{font-size:14px;font-weight:650;color:#354c3e;margin:0 0 8px}.boundaries p{font-size:12px;margin:0;line-height:1.8}.footer{display:flex;justify-content:space-between;flex-wrap:wrap;gap:8px;margin-top:25px;color:#7d8a80;font-size:10px;font-family:var(--mono)}@media(max-width:760px){.shell{padding:24px 16px}.masthead{padding-bottom:20px}.edition{font-size:10px}.intro{grid-template-columns:1fr;padding-top:28px;gap:23px}.summary-grid{padding-left:0;gap:35px}.stat strong{font-size:28px}.notice{display:block}.notice strong{display:block;margin-bottom:3px}.environment{margin-bottom:23px;font-size:10px;gap:6px 12px}.demo-heading{padding:21px 18px 18px;gap:11px;flex-wrap:wrap}.demo-number{width:30px;height:30px;font-size:12px}.demo-title h2{font-size:17px}.badge{margin-left:41px;margin-top:-5px}.metrics{margin:0 18px 18px 59px;gap:12px 21px}.checks summary{padding:14px 18px}.checks ul{grid-template-columns:1fr;padding:0 18px 18px}.artifacts{padding:18px}.image-grid{grid-template-columns:1fr}.artifact-toolbar{gap:9px}.view-switch button{padding:4px 9px}.demo-limits{padding:15px 18px}.boundaries{padding:18px}.check-count{margin-left:7px}}@media print{body{background:white}.shell{max-width:none;padding:0}.demo{break-inside:avoid;box-shadow:none}.view-switch{display:none}.checks ul{display:grid!important}.checks summary{display:none}.image-grid{grid-template-columns:1fr 1fr!important}.image-grid figure{display:block!important}.footer{color:#666}}
</style></head><body><main class="shell">
<header class="masthead"><div class="brand"><span class="brand-mark" aria-hidden="true">↗</span>AgentSwitch</div><span class="edition">凭据层 / 本地实验记录</span></header>
<section class="intro"><div><p class="eyebrow">先验证机制，再决定接入</p><h1>${escape(title)}</h1><p class="subtitle">观察短引用、截图遮罩与页面数据搬运的实际行为，保留每项检查及可查看的实验产物。</p></div><div class="summary-grid" aria-label="实验统计"><div class="stat"><strong>${demos.length}</strong><span>项演示</span></div><div class="stat success"><strong>${passed}</strong><span>项检查通过</span></div><div class="stat ${failed ? 'failure' : ''}"><strong>${failed}</strong><span>项检查未通过</span></div></div></section>
<aside class="notice"><strong>虚构数据 · 隔离原型</strong><span>本报告来自独立实验环境，未接入真实账户、运行中的服务或模型调用。</span></aside>
<div class="environment" aria-label="运行环境">${environment.map(([key, value]) => `<span>${escape(key)} <b>${escape(valueText(value))}</b></span>`).join('')}</div>
<div class="demos">${demos.map(renderDemo).join('')}</div>
<section class="boundaries"><h2>如何理解这些结果</h2><p>“通过”表示该检查在本次虚构样本与受控条件下满足预期。它不代表任意页面上的个人信息都能被识别，也不等于生产环境的截图保密保证。正式接入仍需核对浏览器工具、代理通道和生命周期。</p>${limits.length ? `<ul>${limits.map((item) => `<li>${escape(item)}</li>`).join('')}</ul>` : ''}</section>
<footer class="footer"><span>本地文件 · 无远程资源</span><span>生成时间 ${escape(report.generatedAt ?? '未记录')}</span></footer>
</main><script>
document.addEventListener('click', function (event) {
  if (!(event.target instanceof Element)) return;
  var button = event.target.closest('button[data-view]');
  if (!button) return;
  var mode = button.getAttribute('data-view');
  if (mode !== 'before' && mode !== 'after' && mode !== 'compare') return;
  var section = button.closest('.artifacts');
  if (!section) return;
  section.setAttribute('data-mode', mode);
  section.querySelectorAll('button[data-view]').forEach(function (item) {
    item.setAttribute('aria-pressed', item === button ? 'true' : 'false');
  });
});
</script></body></html>`;
}
