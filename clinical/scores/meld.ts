/**
 * MELD Score (Model for End-Stage Liver Disease)
 * Predicts 3-month mortality in patients with end-stage liver disease.
 * Used for liver transplant prioritization.
 * 
 * Reference: Kamath PS, et al. Hepatology. 2001;33(2):464-470.
 * Updated MELD-Na: Kim WR, et al. Hepatology. 2008;47(4):1363-1370.
 * 
 * MELD = 10 × (0.957 × ln(Creatinine) + 0.378 × ln(Bilirubin) + 1.120 × ln(INR) + 0.643)
 * MELD-Na adjusts for serum sodium.
 */

export interface MeldInput {
  creatinine: number;   // mg/dL (capped at 4.0, minimum 1.0)
  bilirubin: number;    // mg/dL (minimum 1.0)
  inr: number;          // International Normalized Ratio (minimum 1.0)
  sodium?: number;      // mEq/L (for MELD-Na, capped 125-137)
  isOnDialysis?: boolean; // If on dialysis, creatinine is set to 4.0
}

export interface MeldResult {
  meld: number;
  meldNa: number | null;
  mortality3Month: string;
  interpretation: string;
  recommendation: string;
}

export function calculateMeld(input: MeldInput): MeldResult {
  let { creatinine, bilirubin, inr } = input;

  // Apply MELD constraints
  if (input.isOnDialysis) creatinine = 4.0;
  creatinine = Math.max(1.0, Math.min(creatinine, 4.0));
  bilirubin = Math.max(1.0, bilirubin);
  inr = Math.max(1.0, inr);

  // MELD calculation
  const meldRaw =
    10 *
    (0.957 * Math.log(creatinine) +
      0.378 * Math.log(bilirubin) +
      1.12 * Math.log(inr) +
      0.643);

  const meld = Math.round(Math.max(6, Math.min(meldRaw, 40)));

  // MELD-Na calculation (if sodium provided)
  let meldNa: number | null = null;
  if (input.sodium !== undefined) {
    const na = Math.max(125, Math.min(input.sodium, 137));
    const meldNaRaw =
      meld + 1.32 * (137 - na) - 0.033 * meld * (137 - na);
    meldNa = Math.round(Math.max(6, Math.min(meldNaRaw, 40)));
  }

  const effectiveScore = meldNa ?? meld;
  const { mortality3Month, interpretation, recommendation } =
    classifyMeld(effectiveScore);

  return {
    meld,
    meldNa,
    mortality3Month,
    interpretation,
    recommendation,
  };
}

function classifyMeld(score: number) {
  if (score <= 9) {
    return {
      mortality3Month: "1.9%",
      interpretation: "Low severity liver disease. Good short-term prognosis.",
      recommendation: "Continue current management. Monitor liver function periodically.",
    };
  }
  if (score <= 19) {
    return {
      mortality3Month: "6.0%",
      interpretation: "Moderate severity liver disease. Increasing mortality risk.",
      recommendation: "Close hepatology follow-up. Evaluate for transplant listing if disease is progressive. Avoid hepatotoxic medications.",
    };
  }
  if (score <= 29) {
    return {
      mortality3Month: "19.6%",
      interpretation: "Severe liver disease. Significant mortality risk.",
      recommendation: "Urgent hepatology consultation. Evaluate for liver transplant. Aggressive management of complications (ascites, variceal bleeding, encephalopathy). Extreme caution with all medications.",
    };
  }
  return {
    mortality3Month: "71.3%",
    interpretation: "Very severe liver disease. Very high short-term mortality.",
    recommendation: "Emergent transplant evaluation. ICU-level care may be needed. Palliative care discussion if transplant is not an option.",
  };
}
