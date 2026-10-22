import { useEffect, useRef, useState, type RefObject } from 'react';
import * as PopoverPrimitive from '@radix-ui/react-popover';
import { ChevronLeft, ChevronRight, FileText, FolderOpen, Paperclip, Plus, SquareSlash, WandSparkles } from 'lucide-react';
import { NO_SKILLS, useApp, useSessionField } from '@/state/store';
import { useT } from '@/i18n/useT';
import { insertAtCaret } from '@/runtime/paste';
import { chooseAttachmentFile } from '@/runtime/tauri';

/**
 * The plus button's menu: three entries, two of them with a second page.
 *
 * **One popover, pages inside it.** The reference design's flyout is a menu
 * whose submenus slide in place; a Radix `DropdownMenu` would give real
 * submenus but no room for a list of skills to breathe, so the menu is drawn
 * as pages inside one anchored popover — the root page, a page for files, a
 * page for skills. A page transition is a `setState`, a submenu library is a
 * dependency; the interaction this build needs (pick one thing, popover
 * closes) is identical either way.
 *
 * What each entry does:
 *  - **文件 · 工作区文件** — the files panel, opened *as a picker*: picking a
 *    row attaches the file instead of reading it (`store.filePick`).
 *  - **文件 · 浏览** — the OS file dialog; the picked path is attached like a
 *    pasted picture's, as a placeholder in the draft (`⟦file-0⟧`) with the
 *    real path restored at submit.
 *  - **技能** — this session's skills (loaded and available); picking one
 *    inserts the name into the draft at the caret.
 *  - **命令** — the command palette, which is what the plus used to open
 *    directly and what `Ctrl+K` still opens.
 */

type Page = 'root' | 'file' | 'skills';
type T = ReturnType<typeof useT>;

export function PlusMenu({
  taRef,
  disabled,
}: {
  taRef: RefObject<HTMLTextAreaElement | null>;
  disabled: boolean;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [page, setPage] = useState<Page>('root');
  // The trigger button, so the menu can hand focus back when it closes — the
  // composer's own effect would do it, but only via the "nothing else holds
  // focus" rule, and an explicit return is one less condition to reason about.
  const triggerRef = useRef<HTMLButtonElement>(null);

  // Every open starts at the root, never where the last visit left off.
  useEffect(() => {
    if (open) setPage('root');
  }, [open]);

  /** Insert a token into the draft at the textarea's caret. */
  function insertToken(token: string): void {
    const s = useApp.getState();
    const el = taRef.current;
    const draft = s.sessions[s.activeKey ?? '']?.draft ?? '';
    const at = el?.selectionStart ?? draft.length;
    const moved = insertAtCaret(draft, at, token);
    s.setDraft(moved.text);
    requestAnimationFrame(() => {
      const element = taRef.current;
      if (!element) return;
      element.selectionStart = moved.caret;
      element.selectionEnd = moved.caret;
      element.focus();
    });
  }

  function close(): void {
    setOpen(false);
    requestAnimationFrame(() => triggerRef.current?.focus());
  }

  return (
    <PopoverPrimitive.Root open={open} onOpenChange={setOpen}>
      <PopoverPrimitive.Trigger asChild>
        <button
          ref={triggerRef}
          type="button"
          className="cp-add"
          aria-label={t('composer.tools')}
          aria-haspopup="menu"
          disabled={disabled}
        >
          <Plus size={16} />
        </button>
      </PopoverPrimitive.Trigger>

      <PopoverPrimitive.Portal>
        <PopoverPrimitive.Content
          className="plus-menu"
          align="start"
          sideOffset={6}
          aria-label={t('composer.tools')}
          onOpenAutoFocus={(e) => e.preventDefault()}
        >
          {page === 'root' ? (
            <RootPage t={t} onFile={() => setPage('file')} onSkills={() => setPage('skills')} onCommands={close} />
          ) : page === 'file' ? (
            <FilePage t={t} onBack={() => setPage('root')} onDone={close} />
          ) : (
            <SkillsPage
              t={t}
              onBack={() => setPage('root')}
              onPick={(name) => {
                insertToken(name);
                close();
              }}
            />
          )}
        </PopoverPrimitive.Content>
      </PopoverPrimitive.Portal>
    </PopoverPrimitive.Root>
  );
}

/* ---------------- The root page: the three entries ---------------- */

function RootPage({
  t,
  onFile,
  onSkills,
  onCommands,
}: {
  t: T;
  onFile: () => void;
  onSkills: () => void;
  onCommands: () => void;
}) {
  return (
    <div className="plus-menu-list scroll-fade">
      <button type="button" className="plus-item" onClick={onFile}>
        <Paperclip size={15} />
        <span className="plus-item-label">{t('plus.file')}</span>
        <ChevronRight size={13} className="muted" />
      </button>
      <button type="button" className="plus-item" onClick={onSkills}>
        <WandSparkles size={15} />
        <span className="plus-item-label">{t('plus.skills')}</span>
        <ChevronRight size={13} className="muted" />
      </button>
      <button
        type="button"
        className="plus-item"
        onClick={() => {
          // The palette is a modal panel, not a page here: the popover gives
          // way to it, which is also what keeps one panel at a time true.
          useApp.getState().openPanel('commands');
          onCommands();
        }}
      >
        <SquareSlash size={15} />
        <span className="plus-item-label">{t('plus.commands')}</span>
        <span className="plus-item-hint">Ctrl K</span>
      </button>
    </div>
  );
}

/* ---------------- The file page: workspace browser or OS dialog ---------------- */

function FilePage({ t, onBack, onDone }: { t: T; onBack: () => void; onDone: () => void }) {
  // Only to decide whether the picker entry is enabled: a session without a
  // workspace has no tree to walk, and opening the panel would show one
  // refusal where a disabled row says it plainer.
  const rt = useApp((s) => s.sessions[s.activeKey ?? '']);
  const noWorkspace = (rt?.session?.workspace ?? rt?.workspace ?? '').trim() === '';

  return (
    <div className="plus-menu-page">
      <MenuBack label={t('plus.file')} onBack={onBack} />
      <div className="plus-menu-list scroll-fade">
        <button
          type="button"
          className="plus-item"
          onClick={() => {
            if (noWorkspace) return;
            useApp.getState().openFilePicker();
            onDone();
          }}
          disabled={noWorkspace}
        >
          <FolderOpen size={15} />
          <span className="plus-item-label">{t('plus.workspaceFile')}</span>
          {noWorkspace ? <span className="plus-item-hint">{t('plus.noWorkspace')}</span> : null}
        </button>
        <button
          type="button"
          className="plus-item"
          onClick={() => {
            // The dialog opens after the popover is gone: a native dialog over
            // a window whose menu is still up reads as two layers.
            onDone();
            void (async () => {
              const s = useApp.getState();
              const path = await chooseAttachmentFile();
              if (path === null) return;
              // Re-read the caret at insert time, not at click time — the
              // popover's close gave the textarea back before the dialog
              // opened, so this is where the person left it.
              const el = document.querySelector<HTMLTextAreaElement>('.composer textarea');
              const draft = s.sessions[s.activeKey ?? '']?.draft ?? '';
              const at = el?.selectionStart ?? draft.length;
              s.attachFilePath(path, at);
            })();
          }}
        >
          <FileText size={15} />
          <span className="plus-item-label">{t('plus.browse')}</span>
        </button>
      </div>
    </div>
  );
}

/* ---------------- The skills page: this session's catalogue ---------------- */

function SkillsPage({
  t,
  onBack,
  onPick,
}: {
  t: T;
  onBack: () => void;
  onPick: (name: string) => void;
}) {
  // The session's own catalogue: what is loaded now, and what could still be.
  // Asked for fresh on every open, because the runtime may have loaded one
  // since the last snapshot. The effect runs once per mount — the page unmounts
  // when the popover closes, so "every open" is what this is.
  useEffect(() => {
    useApp.getState().requestSkills();
  }, []);

  const loaded = useSessionField((rt) => rt.skills, NO_SKILLS);
  const available = useSessionField((rt) => rt.skillAvailable, NO_SKILLS);

  const rows = [
    ...loaded.map((skill) => ({ name: skill.name, description: skill.description, loaded: true })),
    ...available.map((skill) => ({ name: skill.name, description: skill.description, loaded: false })),
  ];

  return (
    <div className="plus-menu-page">
      <MenuBack label={t('plus.skills')} onBack={onBack} />
      <div className="plus-menu-list scroll-fade">
        {rows.length === 0 ? (
          <div className="plus-menu-empty">{t('panel.skills.empty')}</div>
        ) : (
          rows.map((skill) => (
            <button
              key={`${skill.name}-${skill.loaded ? 'l' : 'a'}`}
              type="button"
              className="plus-item"
              title={skill.description ?? undefined}
              onClick={() => onPick(skill.name)}
            >
              <WandSparkles size={14} className="muted" />
              <span className="plus-item-label mono">{skill.name}</span>
              {skill.loaded ? <span className="plus-item-badge">{t('panel.skills.loaded')}</span> : null}
            </button>
          ))
        )}
      </div>
    </div>
  );
}

/* ---------------- Shared rows ---------------- */

function MenuBack({ label, onBack }: { label: string; onBack: () => void }) {
  return (
    <button type="button" className="plus-item plus-item-back" onClick={onBack}>
      <ChevronLeft size={14} className="muted" />
      <span className="plus-item-label">{label}</span>
    </button>
  );
}
