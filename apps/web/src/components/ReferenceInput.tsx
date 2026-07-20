import { useEffect, useState } from "react";
import { api, type BlockRef } from "../api.ts";

/** Select control for a reference field: lists blocks of the target type. */
export function ReferenceInput({
  refTypeId,
  value,
  onChange,
}: {
  refTypeId?: string;
  value: unknown;
  onChange: (value: unknown) => void;
}) {
  const [opts, setOpts] = useState<BlockRef[]>([]);

  useEffect(() => {
    if (!refTypeId) return;
    void api
      .get<BlockRef[]>(`/blocks/references?typeId=${encodeURIComponent(refTypeId)}`)
      .then(setOpts)
      .catch(() => setOpts([]));
  }, [refTypeId]);

  if (!refTypeId) return <span className="hint">No target type set</span>;

  const val = value == null ? "" : String(value);
  return (
    <select value={val} onChange={(e) => onChange(e.target.value || null)}>
      <option value="">—</option>
      {opts.map((o) => (
        <option key={o.id} value={o.id}>
          {o.label}
        </option>
      ))}
      {val && !opts.some((o) => o.id === val) && <option value={val}>(unknown)</option>}
    </select>
  );
}
