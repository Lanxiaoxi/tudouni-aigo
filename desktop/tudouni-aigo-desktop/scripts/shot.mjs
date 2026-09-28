// 用 CDP 做真实时序截图：不启用 virtual time，让页面按真实时间跑完再抓图。
// 用法: node shot.mjs <url> <out.png> <waitMs> <w> <h> <light|dark> [port] [actionJs] [postWaitMs]
import { writeFileSync } from 'node:fs';

const [
  ,
  ,
  url,
  out,
  waitMsArg,
  wArg,
  hArg,
  scheme = 'light',
  portArg = '9333',
  actionJs = '',
  postWaitArg = '0',
] = process.argv;
const waitMs = Number(waitMsArg ?? 6000);
const postWaitMs = Number(postWaitArg ?? 0);
const width = Number(wArg ?? 1440);
const height = Number(hArg ?? 900);
const port = Number(portArg);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function listTargets() {
  const res = await fetch(`http://127.0.0.1:${port}/json/list`);
  return res.json();
}

async function main() {
  // 新建标签页并导航
  const created = await fetch(
    `http://127.0.0.1:${port}/json/new?${encodeURIComponent(url)}`,
    { method: 'PUT' },
  ).then((r) => r.json());

  const wsUrl = created.webSocketDebuggerUrl;
  if (!wsUrl) throw new Error('no webSocketDebuggerUrl');

  const ws = new WebSocket(wsUrl);
  await new Promise((res, rej) => {
    ws.addEventListener('open', res, { once: true });
    ws.addEventListener('error', rej, { once: true });
  });

  let id = 0;
  const pending = new Map();
  ws.addEventListener('message', (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg.result);
      pending.delete(msg.id);
    }
  });

  const send = (method, params = {}) =>
    new Promise((resolve) => {
      const mid = ++id;
      pending.set(mid, resolve);
      ws.send(JSON.stringify({ id: mid, method, params }));
    });

  await send('Page.enable');
  await send('Emulation.setDeviceMetricsOverride', {
    width,
    height,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await send('Emulation.setEmulatedMedia', {
    features: [{ name: 'prefers-color-scheme', value: scheme }],
  });

  // 指标覆盖会触发一次重排，重新加载保证首帧脚本拿到正确主题
  await send('Page.navigate', { url });
  await sleep(waitMs);

  if (actionJs) {
    const r = await send('Runtime.evaluate', {
      expression: actionJs,
      returnByValue: true,
      awaitPromise: false,
    });
    if (r?.exceptionDetails) console.error('action threw', r.exceptionDetails.text);
    await sleep(postWaitMs || 600);
  }

  const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  writeFileSync(out, Buffer.from(shot.data, 'base64'));

  const targets = await listTargets();
  const ours = targets.find((t) => t.id === created.id);

  // 顺手把关键状态读出来，便于和截图交叉核对
  const html = await send('Runtime.evaluate', {
    expression: 'document.documentElement.dataset.theme',
    returnByValue: true,
  });
  const dump = await send('Runtime.evaluate', {
    expression: `(() => {
      const q = (s) => document.querySelector(s);
      const txt = (s) => (q(s) ? q(s).innerText.replace(/\\s+/g,' ').slice(0,160) : null);
      return JSON.stringify({
        theme: document.documentElement.dataset.theme,
        booting: !!q('.booting'),
        welcome: !!q('.welcome'),
        streamRows: document.querySelectorAll('.stream-inner > *').length,
        answer: !!q('.e-answer'),
        modal: q('.dialog') ? (q('.dialog').querySelector('.dialog-title')||{}).textContent : null,
        blocks: document.querySelectorAll('.sb-block').length,
        sessionbar: txt('.sessionbar'),
        statusbar: txt('.statusbar'),
        sidebar: txt('.app-sidebar'),
        toast: txt('.e-note'),
      });
    })()`,
    returnByValue: true,
  });

  console.log('target', ours?.id, 'themeAttr', html?.result?.value);
  console.log('state', dump?.result?.value);
  console.log('bytes', Buffer.from(shot.data, 'base64').length);

  // 收尾：关掉这个标签页
  await fetch(`http://127.0.0.1:${port}/json/close/${created.id}`);
  ws.close();
}

main().catch((e) => {
  console.error('FAIL', e);
  process.exit(1);
});
