import {
  forwardRef,
  type ComponentPropsWithoutRef,
  type CSSProperties,
} from 'react';

/**
 * Inverted-palette form fields.
 *
 * The page background and the field background are inverses of each
 * other (dark page → white field, light page → dark field). This makes
 * "where you type" visually distinct without extra chrome — no boxes
 * inside boxes, no extra borders. The styling lives on the `.form-input`
 * / `.form-textarea` / `.form-select` CSS classes in design-system.css,
 * driven by the `--bg-field` / `--text-field` / `--border-field`
 * tokens. These wrappers just apply the right class to the right
 * native element so callers don't have to remember the convention.
 *
 * Usage:
 *   <Field type="email" value={email} onChange={...} placeholder="..." />
 *   <FieldArea rows={4} value={text} onChange={...} />
 *   <FieldSelect value={val} onChange={...}>
 *     <option value="a">A</option>
 *   </FieldSelect>
 *
 * For new code prefer these wrappers; existing markup using bare
 * `<input className="form-input" />` etc. keeps working unchanged.
 */

type FieldSize = 'sm' | 'md' | 'lg';

const sizeStyles: Record<FieldSize, CSSProperties> = {
  sm: { padding: '0.4rem 0.625rem', fontSize: '0.825rem' },
  md: {},
  lg: { padding: '0.875rem 1rem', fontSize: '1rem' },
};

function mergeClass(...parts: Array<string | false | undefined>): string {
  return parts.filter((p): p is string => typeof p === 'string' && p.length > 0).join(' ');
}

// ─── Field (text-style inputs) ──────────────────────────────────────────

export interface FieldProps extends Omit<ComponentPropsWithoutRef<'input'>, 'size'> {
  /** Visual size. Default 'md'. */
  size?: FieldSize;
  /** Marks the field as in error — adds a red focus ring. */
  invalid?: boolean;
}

export const Field = forwardRef<HTMLInputElement, FieldProps>(function Field(
  { size = 'md', invalid, className, style, ...rest },
  ref,
) {
  return (
    <input
      ref={ref}
      className={mergeClass('form-input', invalid && 'form-input-invalid', className)}
      style={{ ...sizeStyles[size], ...style }}
      aria-invalid={invalid || undefined}
      {...rest}
    />
  );
});

// ─── FieldArea (textarea) ──────────────────────────────────────────────

export interface FieldAreaProps extends ComponentPropsWithoutRef<'textarea'> {
  size?: FieldSize;
  invalid?: boolean;
}

export const FieldArea = forwardRef<HTMLTextAreaElement, FieldAreaProps>(function FieldArea(
  { size = 'md', invalid, className, style, ...rest },
  ref,
) {
  return (
    <textarea
      ref={ref}
      className={mergeClass('form-textarea', invalid && 'form-input-invalid', className)}
      style={{ ...sizeStyles[size], ...style }}
      aria-invalid={invalid || undefined}
      {...rest}
    />
  );
});

// ─── FieldSelect (select) ──────────────────────────────────────────────

export interface FieldSelectProps extends Omit<ComponentPropsWithoutRef<'select'>, 'size'> {
  size?: FieldSize;
  invalid?: boolean;
}

export const FieldSelect = forwardRef<HTMLSelectElement, FieldSelectProps>(function FieldSelect(
  { size = 'md', invalid, className, style, children, ...rest },
  ref,
) {
  return (
    <select
      ref={ref}
      className={mergeClass('form-select', invalid && 'form-input-invalid', className)}
      style={{ ...sizeStyles[size], ...style }}
      aria-invalid={invalid || undefined}
      {...rest}
    >
      {children}
    </select>
  );
});
