import { Folder } from 'lucide-react';
import { Select } from '@/components/ui/Select';
import { useT } from '@/i18n/useT';
import { ALL_WORKSPACES, type WorkspaceScope } from '@/utils/workspaceFilter';

/**
 * The boards' workspace filter: one dropdown, "All workspaces" first.
 *
 * **Drawn only when there is a choice.** With every card in one workspace the
 * dropdown could only ever say what the board already shows, and a control
 * that changes nothing teaches people to ignore it — the same rule the Idle
 * column's close button follows. The caller keeps its state; this is the face.
 */
export function WorkspaceFilter({
  value,
  options,
  onChange,
}: {
  value: string;
  options: readonly WorkspaceScope[];
  onChange: (key: string) => void;
}) {
  const t = useT();
  if (options.length < 2) return null;
  const items = [
    { value: ALL_WORKSPACES, label: t('board.wsFilter.all') },
    ...options.map((scope) => ({
      value: scope.key,
      label: scope.label === '' ? t('board.wsFilter.none') : scope.label,
    })),
  ];
  const chosen = options.find((scope) => scope.key === value);
  return (
    <div className="ws-filter" title={chosen?.title || undefined}>
      <Folder size={13} aria-hidden />
      <Select
        value={value}
        options={items}
        onChange={onChange}
        ariaLabel={t('board.wsFilter.label')}
        searchable={items.length > 8}
      />
    </div>
  );
}
