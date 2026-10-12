import { useEffect, useState } from 'react';
import { isHosted } from '@/runtime/tauri';

/**
 * What the whole application is using right now, from the host's sample.
 *
 * The CPU figures are percentages of **the machine** (the Rust side divides by
 * the core count) and the memory figures are bytes. A `null` sample means
 * "no reading yet", and the callers draw nothing rather than a zero.
 */
export interface ResourceUsageView {
  shellCpu: number;
  shellMem: number;
  runtimesCpu: number;
  runtimesMem: number;
  systemMemUsed: number;
  systemMemTotal: number;
}

/**
 * A slow sample of the application's CPU and memory, for the status bar.
 *
 * **Two seconds, and that is the whole of its design.** The refresh on the
 * host side scans the machine's processes, so the tick is slow by rule rather
 * than by tuning — a sample a person reads at a glance does not need to move
 * any faster than a breath. In a plain browser there is no host, and the hook
 * returns `null` forever rather than touching an IPC surface that is not there.
 *
 * The value is state, not a promise: an invoke that fails (the host mid-boot,
 * a command the current build does not have) must not wedge the row, so a
 * rejected sample is kept as `null` until the next tick retries.
 */
export function useResourceUsage(): ResourceUsageView | null {
  const [usage, setUsage] = useState<ResourceUsageView | null>(null);

  useEffect(() => {
    if (!isHosted()) return;
    let disposed = false;

    const tick = async () => {
      try {
        const mod = await import('@tauri-apps/api/core');
        const sample = await mod.invoke<ResourceUsageView>('resource_usage');
        if (!disposed) setUsage(sample);
      } catch {
        // A failed sample stays `null`; the next tick retries.
      }
    };

    void tick();
    const timer = setInterval(() => void tick(), 2000);
    return () => {
      disposed = true;
      clearInterval(timer);
    };
  }, []);

  return usage;
}
