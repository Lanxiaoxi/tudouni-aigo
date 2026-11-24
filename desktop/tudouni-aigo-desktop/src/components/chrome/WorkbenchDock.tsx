import { useState } from 'react';
import * as PopoverPrimitive from '@radix-ui/react-popover';
import { Wrench } from 'lucide-react';
import { useT } from '@/i18n/useT';
import { Count } from '@/components/ui/kit';
import { useWorkbenchNav, WorkbenchDrawerBody } from '@/components/sidebar/workbenchNav';

/**
 * The workbench's **second door**, for the case the first one is gone.
 *
 * The left rail's foot is the drawer's home, but it is *inside the thing it
 * opens*: fold the rail and the card is `inert` along with it (the whole
 * wrapper is), so a person who folded the sidebar has no workbench at all.
 * This is the workbench's copy of the rule the session bar's two board doors
 * already follow — *a control inside the thing it acts on goes away with it*.
 *
 * It is drawn only while the rail is away (`App` gates it on `!showLeftbar`),
 * so the two doors are never on screen at once: one workbench, two entrances.
 * It docks to the **bottom left** of the conversation column — the mirror of
 * the notice center's capsule at the bottom right, which is the spot a
 * person's eye already knows for "things that stand in for a folded surface".
 * The trigger wears the rail's own identification face (the dark tile with the
 * wrench), so the two read as one object in two places rather than two
 * features.
 *
 * What it opens is the **same drawer** the rail's foot holds, from the same
 * source: `useWorkbenchNav`'s items, gates, badges and attention count, and
 * `WorkbenchDrawerBody`'s filter and rows. The two surfaces must not drift —
 * a gate written once here and once in the rail would disagree the first time
 * one changed, which is the failure the shared hook exists to make
 * impossible. The filter is this dock's own state, not the rail's: the two
 * drawers are never on screen at once, and a shared query would surface in the
 * rail the moment it returned.
 */
export function WorkbenchDock() {
  const t = useT();
  const { items, attention } = useWorkbenchNav();
  const [open, setOpen] = useState(false);
  // Every drawer row is inert while a modal is up, so the box must not keep
  // its own filter alive either — the rail's head clears it on close, and
  // this one does the same through the popover's own `onOpenChange`.
  const [navQuery, setNavQuery] = useState('');

  return (
    <PopoverPrimitive.Root
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setNavQuery('');
      }}
    >
      <div className="wb-dock">
        <PopoverPrimitive.Trigger asChild>
          <button
            type="button"
            className="wb-dock-trigger"
            aria-label={t('lb.workbench.floatHint')}
            aria-haspopup="menu"
          >
            <Wrench size={15} aria-hidden />
            {attention > 0 ? <Count value={attention} attention /> : null}
          </button>
        </PopoverPrimitive.Trigger>
      </div>
      <PopoverPrimitive.Portal>
        <PopoverPrimitive.Content
          className="wb-drawer"
          side="top"
          align="start"
          sideOffset={10}
          aria-label={t('lb.workbench')}
          onOpenAutoFocus={(e) => e.preventDefault()}
        >
          <div className="wb-drawer-head">
            <span className="wb-drawer-mark" aria-hidden>
              <Wrench size={14} />
            </span>
            <span className="wb-drawer-title">{t('lb.workbench')}</span>
            {attention > 0 ? <Count value={attention} attention /> : null}
          </div>
          <div className="wb-drawer-body">
            <WorkbenchDrawerBody items={items} query={navQuery} onQuery={setNavQuery} />
          </div>
        </PopoverPrimitive.Content>
      </PopoverPrimitive.Portal>
    </PopoverPrimitive.Root>
  );
}
