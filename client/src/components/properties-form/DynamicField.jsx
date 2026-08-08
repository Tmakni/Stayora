import { Input } from '../ui/input';
import { Textarea } from '../ui/textarea';
import { Label } from '../ui/label';
import { Checkbox } from '../ui/checkbox';
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from '../ui/select';
import { PROPERTY_TYPES } from '../../lib/constants';
import { cn } from '../../lib/utils';

const OPTION_SOURCES = {
  PROPERTY_TYPES,
};

// Radix <Select.Item> forbids an empty-string value, so "no value selected"
// options (e.g. "Non renseigné") are remapped to this sentinel and back.
const EMPTY_SENTINEL = '__none__';

export function DynamicField({ field, value, onChange }) {
  const options = Array.isArray(field.options) ? field.options : OPTION_SOURCES[field.options] || [];
  const hasEmptyOption = options.some((opt) => opt.value === '');

  if (field.type === 'checkbox') {
    return (
      <label className={cn('flex cursor-pointer items-center gap-2 py-1 text-sm text-foreground', field.span === 2 && 'sm:col-span-2')}>
        <Checkbox checked={!!value} onCheckedChange={(v) => onChange(!!v)} />
        {field.label}
      </label>
    );
  }

  return (
    <div className={cn('space-y-1.5', field.span === 2 && 'sm:col-span-2')}>
      <Label htmlFor={field.key}>
        {field.label}
        {field.required && <span className="text-danger"> *</span>}
      </Label>

      {field.type === 'select' ? (
        <Select
          value={value ? String(value) : hasEmptyOption ? EMPTY_SENTINEL : ''}
          onValueChange={(v) => onChange(v === EMPTY_SENTINEL ? '' : v)}
        >
          <SelectTrigger id={field.key}>
            <SelectValue placeholder="Sélectionner…" />
          </SelectTrigger>
          <SelectContent>
            {options.map((opt) => (
              <SelectItem key={opt.value || EMPTY_SENTINEL} value={opt.value || EMPTY_SENTINEL}>
                {opt.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      ) : field.type === 'textarea' ? (
        <Textarea id={field.key} value={value || ''} onChange={(e) => onChange(e.target.value)} rows={3} />
      ) : (
        <Input
          id={field.key}
          type={field.type === 'number' ? 'number' : field.type === 'time' ? 'time' : 'text'}
          value={value ?? ''}
          onChange={(e) => onChange(field.type === 'number' ? e.target.value.replace(/[^0-9.]/g, '') : e.target.value)}
        />
      )}
      {field.hint && <p className="text-xs text-muted-foreground">{field.hint}</p>}
    </div>
  );
}
