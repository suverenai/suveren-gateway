/** The gateway's pill tabs (`ftabs` / `ftab`, the Tickets page's kind tabs). */
export function Tabs<T extends string>({ items, value, onChange, label }: { items: Array<{ id: T; label: string }>; value: T; onChange: (id: T) => void; label: string }) {
  return (
    <div className="ftabs" role="tablist" aria-label={label}>
      {items.map((i) => (
        <button key={i.id} type="button" role="tab" className="ftab" aria-selected={i.id === value} onClick={() => onChange(i.id)}>{i.label}</button>
      ))}
    </div>
  );
}
