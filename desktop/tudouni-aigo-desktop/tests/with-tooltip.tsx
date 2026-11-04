/**
 * The tooltip context a static render needs.
 *
 * `Tip` is a Radix tooltip, and Radix refuses to render one without a provider
 * above it. The real app supplies the provider once, at the root (`App.tsx`); a
 * test that renders `Markdown` or `EntryView` on its own has to be given the
 * same context, or it throws before the assertion runs, and the throw is about
 * the harness, not about the component under test.
 */

import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server.browser';
import * as Tooltip from '@radix-ui/react-tooltip';

export function renderWithTooltip(node: ReactNode): string {
  return renderToStaticMarkup(<Tooltip.Provider>{node}</Tooltip.Provider>);
}
