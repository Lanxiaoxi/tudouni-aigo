import { useLayoutEffect } from 'react';
import { createMockRuntime } from './mockRuntime';
import { setRuntime } from './bus';
import { useApp } from '@/state/store';

/** 演示开场白。只在 ?demo=1 时用，不是产品文案 */
const DEMO_PROMPT = '把鉴权模块从单 PASSWORD 改成多用户 SQLite，先给我方案。';

/**
 * 把 mock 运行时接到 store 上。
 *
 * 接真运行时的时候，这里只有 createMockRuntime() 那一行需要换 ——
 * 换成一个走 Tauri command / WebSocket / stdio 桥的 Runtime 实现即可。
 *
 * 用 useLayoutEffect 而不是 useEffect：订阅必须在本次提交结束前就位。
 * 运行时是独立进程，握手可能快到来不及等被动 effect ——
 * 一旦 init 在「创建了运行时但还没订阅」的缝隙里到达，界面就会永远停在启动态。
 * useLayoutEffect 是同步的，创建 → 订阅之间没有让步点，不会漏消息。
 *
 * 另外提供两个**仅供评审/演示**的 URL 开关，不参与任何业务逻辑：
 *   ?demo=1  启动后自动发一条消息，直接把整条链路跑起来
 *   ?auto=1  配合 demo，自动应答两个阻塞模态（模拟人点了「允许」和「提交」），
 *            这样能一次看到回答块、压缩痕迹等全部条目形态
 */
export function useRuntimeBridge(): void {
  useLayoutEffect(() => {
    const rt = createMockRuntime();
    setRuntime(rt);

    const off = rt.subscribe((msg) => {
      useApp.getState().applyRuntimeMessage(msg);
    });

    const params = new URLSearchParams(window.location.search);
    const demo = params.get('demo') === '1';
    const auto = params.get('auto') === '1';

    let offDemo: (() => void) | null = null;

    if (demo || auto) {
      // 注意：zundand 的监听器在 `listeners.forEach` 里同步串行执行，
      // 一旦某个监听器抛异常，排在其后的监听器（包括 React 的订阅）会被整体跳过，
      // 界面就会冻在上一帧。所以这里：
      //   1. 守卫用局部变量，不用 store 字段（否则 setState 会触发嵌套通知，守卫失效→无限递归）
      //   2. 所有写操作延后一拍出 notify 循环
      let demoKicked = false;

      offDemo = useApp.subscribe((s) => {
        if (demo && !demoKicked && s.ready) {
          demoKicked = true;
          queueMicrotask(() => {
            useApp.setState({ draft: DEMO_PROMPT });
            useApp.getState().submitDraft();
          });
          return;
        }

        if (!auto || !s.modal) return;
        const pendingId = s.modal.req.id;

        queueMicrotask(() => {
          const cur = useApp.getState().modal;
          if (!cur || cur.req.id !== pendingId) return; // 已经处理过了
          if (cur.kind === 'permission') useApp.getState().answerPermission('allow');
          else useApp.getState().answerQuestion('choose', ['d30']);
        });
      });
    }

    return () => {
      offDemo?.();
      off();
      rt.dispose();
      setRuntime(null);
    };
  }, []);
}
