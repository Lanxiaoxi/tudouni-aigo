import ReactSelect, { components, type DropdownIndicatorProps, type OptionProps } from 'react-select';
import { Check, ChevronDown } from 'lucide-react';
import { useT } from '@/i18n/useT';

/**
 * The app's dropdown: `react-select`, unstyled, drawn by `select.css`.
 *
 * It replaces the native `<select>` in the config-style forms, because the list
 * a native select opens is painted by the OS and no stylesheet can reach it.
 *
 * Two choices here are about the Radix dialog every panel lives in:
 *
 * - **The menu is not portalled.** It is drawn inline under the control. A
 *   portal to `body` would sit outside the dialog's pointer-events and its
 *   scroll lock (the wheel would not scroll the list), and the dialog is the
 *   only place these are used. `menuPlacement="auto"` flips it upward when the
 *   dialog body has no room below.
 * - **Esc closes the menu, not the dialog.** Radix handles Esc on `document`
 *   in the capture phase, before react-select sees it, so `PanelHost` asks
 *   `selectMenuIsOpen()` and lets the key through. That is read from the DOM on
 *   purpose: a module flag set by `onMenuOpen` would stay stuck if the dialog
 *   unmounted with a menu up.
 */

export interface SelectOption {
  value: string;
  label: string;
}

export interface SelectProps {
  /** The chosen option's `value`. `null` shows the placeholder (a picker that
   *  acts on the click and has nothing to remember). */
  value: string | null;
  options: readonly SelectOption[];
  onChange: (value: string) => void;
  /** Lands on the focusable element, so a `<label htmlFor>` reaches it. */
  id?: string;
  /** For a control with no visible `<label htmlFor>` of its own. */
  ariaLabel?: string;
  placeholder?: string;
  /** Same two caps `.cfg-input.is-short` / `.is-tiny` give a text field. */
  size?: 'short' | 'tiny';
  mono?: boolean;
  /** Type-to-filter. Off by default: most lists here have a handful of rows. */
  searchable?: boolean;
  disabled?: boolean;
}

/** True while any select menu is drawn. See the note on Esc above. */
export function selectMenuIsOpen(): boolean {
  return typeof document !== 'undefined' && document.querySelector('.rs-select .rs__menu') !== null;
}

function DropdownIndicator(props: DropdownIndicatorProps<SelectOption, false>) {
  return (
    <components.DropdownIndicator {...props}>
      <ChevronDown size={14} aria-hidden />
    </components.DropdownIndicator>
  );
}

function Option(props: OptionProps<SelectOption, false>) {
  return (
    <components.Option {...props}>
      <span className="rs-option-label">{props.children}</span>
      {props.isSelected ? <Check size={14} aria-hidden /> : null}
    </components.Option>
  );
}

// Module-level so the object keeps its identity: react-select re-mounts a
// component whose reference changes between renders.
const COMPONENTS = { IndicatorSeparator: null, DropdownIndicator, Option };

export function Select({
  value,
  options,
  onChange,
  id,
  ariaLabel,
  placeholder,
  size,
  mono = false,
  searchable = false,
  disabled = false,
}: SelectProps) {
  const t = useT();
  const selected = value === null ? null : (options.find((option) => option.value === value) ?? null);
  return (
    <ReactSelect<SelectOption, false>
      className={`rs-select${size === 'short' ? ' is-short' : ''}${size === 'tiny' ? ' is-tiny' : ''}${
        mono ? ' is-mono' : ''
      }`}
      classNamePrefix="rs"
      unstyled
      inputId={id}
      aria-label={ariaLabel}
      options={options}
      value={selected}
      onChange={(next) => {
        if (next !== null) onChange(next.value);
      }}
      placeholder={placeholder ?? ''}
      isSearchable={searchable}
      isDisabled={disabled}
      isClearable={false}
      // Tab leaves the field. Selecting on Tab would commit a row the person
      // only arrowed past on the way out of the form.
      tabSelectsValue={false}
      maxMenuHeight={240}
      menuPlacement="auto"
      noOptionsMessage={() => t('select.noOptions')}
      components={COMPONENTS}
    />
  );
}
