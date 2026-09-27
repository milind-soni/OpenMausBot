import { useState } from "react";
import { adMeasurementAllowed, adMeasurementAvailable, setAdMeasurementAllowed } from "../lib/ad-measurement";

export function AdMeasurementPreference() {
  const [allowed, setAllowed] = useState(adMeasurementAllowed);
  if (!adMeasurementAvailable()) return null;
  return (
    <div className="mt-5 text-[12px] leading-relaxed opacity-80">
      <label className="flex cursor-pointer items-start gap-2">
        <input type="checkbox" className="mt-1 shrink-0" checked={allowed} onChange={(event) => {
          setAdMeasurementAllowed(event.target.checked);
          setAllowed(adMeasurementAllowed());
        }} />
        <span>Allow optional ad measurement</span>
      </label>
      <p className="mt-1">Shares page visits and signup completion with Meta using cookies to measure our ads. Signup works either way. You can change this here or in General settings.</p>
      <a className="underline underline-offset-2" href="https://www.facebook.com/privacy/policy/" target="_blank" rel="noreferrer">Meta privacy policy</a>
    </div>
  );
}
