/**
 * A labelled on/off switch.
 *
 * **Extracted from the memory panel rather than copied**, because the two panels that use
 * it are making the same promise: one row is one setting, the switch is the setting's whole
 * control, and the label and hint beside it say what changes. A second copy would drift on
 * something invisible — the hint's line height, the switch's focus ring — and a settings
 * screen whose two halves do not line up reads as two screens.
 *
 * A `role="switch"` button rather than a styled checkbox: the two states are one element's
 * own attribute, and nothing has to keep a hidden input in sync with a drawn knob.
 */
export function SwitchRow({
  label,
  hint,
  checked,
  onChange,
  disabled,
}: {
  label: string;
  hint: string;
  checked: boolean;
  onChange: (value: boolean) => void;
  /** Only for a switch the runtime is currently unable to honour — never for one that is
   *  merely off. A disabled control with no reason reads as a broken control. */
  disabled?: boolean;
}) {
  return (
    <div className="wm-switch">
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={label}
        disabled={disabled}
        className={`tk-switch${checked ? ' is-on' : ''}`}
        onClick={() => onChange(!checked)}
      >
        <span className="tk-switch-knob" />
      </button>
      <span className="wm-switch-text">
        <span className="wm-switch-label">{label}</span>
        <span className="wm-switch-hint">{hint}</span>
      </span>
    </div>
  );
}
