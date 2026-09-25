import { useEffect, useRef, useState } from 'react';
import { isSaturday, latestSaturday, PREP_ITEMS, prepDayKey, prepTotals, prepValidation, promoFree, TABLE_ITEMS, validPrepValue, type PrepValues, type SaturdayPrepRecord } from './saturdayPrep';
import { savePrepField, submitSaturdayPrep, subscribeSaturdayPrep } from './saturdayPrepData';

export function SaturdayPrepTab({ storeId, admin = false }: { storeId: string; admin?: boolean }) {
  const [date, setDate] = useState(() => admin ? latestSaturday() : prepDayKey());
  const validDate = isSaturday(date) && date <= prepDayKey();
  return <section className="panel-stack saturday-prep">
    <div className="section-heading">
      <div><p className="eyebrow">Saturday closing log</p><h2>Saturday Prep</h2></div>
      {admin ? <label>Saturday date<input type="date" value={date} max={prepDayKey()}
        onChange={(event) => setDate(event.target.value)} /></label> : <strong>{date}</strong>}
    </div>
    <p>Record weights and prepared quantities at 10 p.m. At 11 p.m., count what is left to throw away.
      The difference is what employees took home and should be Promo Free.</p>
    {validDate ? <PrepForm key={`${storeId}/${date}`} storeId={storeId} date={date} admin={admin} />
      : <p role="alert">Choose a Saturday on or before today.</p>}
  </section>;
}

function PrepForm({ storeId, date, admin }: { storeId: string; date: string; admin: boolean }) {
  const [record, setRecord] = useState<SaturdayPrepRecord | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [pending, setPending] = useState(false);
  const [cached, setCached] = useState(true);
  const [edits, setEdits] = useState<PrepValues>({});
  const versions = useRef<Record<string, number>>({});
  const [error, setError] = useState('');
  const [readError, setReadError] = useState('');
  const [busy, setBusy] = useState(false);
  const [showValidation, setShowValidation] = useState(false);

  useEffect(() => subscribeSaturdayPrep(storeId, date, (next, waiting, fromCache) => {
    setRecord(next);
    setPending(waiting);
    setCached(fromCache);
    setLoaded(true);
    setReadError('');
  }, (caught) => setReadError(`Could not load this log: ${caught.message}`)), [storeId, date]);

  const values = { ...record?.values, ...edits };
  const submitted = !!record?.submittedAt;
  const unsaved = Object.keys(edits).length > 0 || pending;
  const invalidEdits = Object.entries(edits).some(([key, value]) => !validPrepValue(key, value));
  const errors = prepValidation(values);
  const totals = prepTotals(values);

  function save(key: string, value: number | null) {
    const version = (versions.current[key] ?? 0) + 1;
    versions.current[key] = version;
    setEdits((current) => ({ ...current, [key]: value }));
    setError('');
    void savePrepField(storeId, date, key, value).then(() => {
      if (versions.current[key] !== version) return;
      setEdits((current) => {
        const next = { ...current };
        delete next[key];
        return next;
      });
    }).catch((caught: Error) => {
      if (versions.current[key] === version) setError(`Changes could not be saved: ${caught.message}`);
    });
  }

  async function finalize(reopen = false) {
    setShowValidation(!reopen);
    if (!reopen && errors.length) return;
    setBusy(true);
    setError('');
    try { await submitSaturdayPrep(storeId, date, reopen); }
    catch (caught) { setError(caught instanceof Error ? caught.message : 'Could not submit. Please retry.'); }
    finally { setBusy(false); }
  }

  function input(key: string, label: string, max = 10000, fractional = false) {
    return <input className="table-input" aria-label={label} type="number" inputMode={fractional ? 'decimal' : 'numeric'}
      min="0" max={max} step={fractional ? 'any' : 1} value={values[key] ?? ''}
      disabled={submitted || busy || !!readError}
      aria-invalid={values[key] != null && !validPrepValue(key, values[key])}
      onChange={(event) => {
        const value = event.target.value === '' ? null : Number(event.target.value);
        // Keep invalid input visible for correction, but never send it to shared storage.
        if (!validPrepValue(key, value)) {
          versions.current[key] = (versions.current[key] ?? 0) + 1;
          setEdits((current) => ({ ...current, [key]: value }));
          setError(`${label}: enter ${fractional ? 'a quantity' : 'a whole number'} from 0 to ${max}.`);
          return;
        }
        save(key, value);
      }} />;
  }

  if (readError) return <p className="form-error" role="alert">{readError} Reload to try again.</p>;
  if (!loaded) return <p role="status">Loading Saturday log…</p>;

  return <>
    <p className="prep-save-status" role="status" aria-live="polite">
      {invalidEdits ? 'Correct the highlighted entries — they have not been saved'
        : error && unsaved ? 'Some changes have not been saved'
        : unsaved ? (cached ? 'Changes pending — waiting to sync' : 'Saving changes…')
        : cached ? 'Showing saved device data — waiting for connection'
          : submitted ? 'Final submission saved' : record ? 'All changes saved · Draft' : 'Ready · Entries autosave'}
    </p>
    {error && <div className="form-error" role="alert">{error}
      {Object.keys(edits).length > 0 && !invalidEdits && !submitted && <button className="secondary-button" type="button"
        onClick={() => Object.entries(edits).forEach(([key, value]) => {
          if (validPrepValue(key, value)) save(key, value);
        })}>Retry saving</button>}
    </div>}
    {submitted && Object.keys(edits).length > 0 && <div className="form-error" role="alert">
      <p>This log was submitted while you were editing. Your unsaved changes have not replaced the submitted values.</p>
      <button className="secondary-button" onClick={() => {
        Object.keys(versions.current).forEach((key) => { versions.current[key] += 1; });
        setEdits({});
        setError('');
      }}>Use submitted values</button>
    </div>}
    <section className="prep-section">
      <h3>Table items · 10 p.m.</h3>
      <p>Enter whole pounds and remaining ounces separately. Enter 0 in both fields for none.</p>
      <div className="prep-weight-head" aria-hidden="true"><span>Item</span><span>Pounds</span><span>Ounces</span></div>
      {TABLE_ITEMS.map(([id, name]) => <div className="prep-weight-row" key={id}>
        <strong>{name}</strong>{input(`${id}_lb`, `${name} pounds`)}{input(`${id}_oz`, `${name} ounces`, 15.999, true)}
      </div>)}
    </section>
    <section className="prep-section">
      <h3>Prepared items · 10 p.m. → 11 p.m.</h3>
      <p>Left at 11 p.m. is waste. Taken home = 10 p.m. quantity − 11 p.m. quantity. Enter 0 for none.</p>
      {PREP_ITEMS.map(([id, name]) => {
        const unit = id === 'tea' ? 'gallons' : 'each';
        const invalid = values[`${id}_left`] != null && values[`${id}_eod`] != null
          && values[`${id}_left`]! > values[`${id}_eod`]!;
        return <div className="prep-item" key={id}>
          <strong>{name} <small>({unit})</small></strong>
          <div className="prep-item-fields">
            <label>At 10 p.m.{input(`${id}_eod`, `${name} at 10 p.m.`, 10000, id === 'tea')}</label>
            <label>Left at 11 p.m. / wasted{input(`${id}_left`, `${name} left at 11 p.m.`, 10000, id === 'tea')}</label>
            <div><span>Taken home / Promo Free</span><output aria-label={`${name} Promo Free`}>{promoFree(values, id) ?? '—'}</output></div>
          </div>
          {invalid && <p className="form-error" role="alert">Left at 11 p.m. cannot exceed the 10 p.m. quantity.</p>}
        </div>;
      })}
    </section>
    <section className="prep-summary" aria-label="Saturday totals">
      <h3>{submitted ? 'Submitted totals' : 'Totals entered so far'}</h3>
      <p>Table items: <strong>{Math.floor(totals.tableOunces / 16)} lb {Number((totals.tableOunces % 16).toFixed(3))} oz</strong></p>
      <p>Prepared items wasted: <strong>{totals.wastedEach} each</strong> · Promo Free: <strong>{totals.promoEach} each</strong></p>
      <p>Sweet tea wasted: <strong>{totals.wastedGallons} gal</strong> · Promo Free: <strong>{totals.promoGallons} gal</strong></p>
      {!submitted && errors.length > 0 && <p>Totals are incomplete until every field is filled and valid.</p>}
    </section>
    {showValidation && errors.length > 0 && <div className="form-error" role="alert">
      <p>Complete all entries before submitting:</p><ul>{errors.map((message) => <li key={message}>{message}</li>)}</ul>
    </div>}
    {submitted ? <div>
      <p>This log is submitted. {admin ? 'Reopen it to make corrections, then submit again.' : 'Corrections are available in Admin.'}</p>
      {admin && <button className="secondary-button" disabled={busy || cached || unsaved} onClick={() => void finalize(true)}>
        {busy ? 'Reopening…' : 'Reopen for correction'}
      </button>}
    </div> : <div>
      <button className="primary-button" disabled={busy || cached || unsaved} onClick={() => void finalize()}>
        {busy ? 'Submitting…' : 'Final Submit'}
      </button>
      {(cached || unsaved) && <p>Final submission is available after all entries sync.</p>}
    </div>}
  </>;
}
