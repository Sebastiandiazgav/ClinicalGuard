/**
 * CKD-EPI (Chronic Kidney Disease Epidemiology Collaboration) 2021
 * Calculates estimated Glomerular Filtration Rate (eGFR)
 * 
 * This is the race-free 2021 equation recommended by KDIGO.
 * Reference: Inker LA, et al. N Engl J Med. 2021;385(19):1737-1749.
 * 
 * eGFR = 142 × min(Scr/κ, 1)^α × max(Scr/κ, 1)^(-1.200) × 0.9938^Age × (1.012 if female)
 * 
 * Where:
 *   Scr = serum creatinine (mg/dL)
 *   κ = 0.7 (female) or 0.9 (male)
 *   α = -0.241 (female) or -0.302 (male)
 */

export interface CkdEpiInput {
  creatinine: number;   // mg/dL
  age: number;          // years
  isFemale: boolean;
}

export interface CkdEpiResult {
  egfr: number;                    // mL/min/1.73m²
  ckdStage: string;                // G1, G2, G3a, G3b, G4, G5
  ckdDescription: string;          // Human-readable description
  interpretation: string;          // Clinical interpretation
  requiresDoseAdjustment: boolean; // Whether medications need renal adjustment
}

export function calculateCkdEpi(input: CkdEpiInput): CkdEpiResult {
  const { creatinine, age, isFemale } = input;

  const kappa = isFemale ? 0.7 : 0.9;
  const alpha = isFemale ? -0.241 : -0.302;
  const femaleFactor = isFemale ? 1.012 : 1.0;

  const scrOverKappa = creatinine / kappa;
  const minTerm = Math.pow(Math.min(scrOverKappa, 1), alpha);
  const maxTerm = Math.pow(Math.max(scrOverKappa, 1), -1.200);
  const ageTerm = Math.pow(0.9938, age);

  const egfr = Math.round(142 * minTerm * maxTerm * ageTerm * femaleFactor);

  const { stage, description, interpretation, requiresDoseAdjustment } =
    classifyEgfr(egfr);

  return {
    egfr,
    ckdStage: stage,
    ckdDescription: description,
    interpretation,
    requiresDoseAdjustment,
  };
}

function classifyEgfr(egfr: number) {
  if (egfr >= 90) {
    return {
      stage: "G1",
      description: "Normal or high",
      interpretation:
        "Kidney function is normal. No dose adjustments needed for most medications.",
      requiresDoseAdjustment: false,
    };
  }
  if (egfr >= 60) {
    return {
      stage: "G2",
      description: "Mildly decreased",
      interpretation:
        "Mildly reduced kidney function. Monitor renal function. Few medications require adjustment.",
      requiresDoseAdjustment: false,
    };
  }
  if (egfr >= 45) {
    return {
      stage: "G3a",
      description: "Mildly to moderately decreased",
      interpretation:
        "Moderate kidney disease. Several medications require dose adjustment. Avoid nephrotoxic agents when possible.",
      requiresDoseAdjustment: true,
    };
  }
  if (egfr >= 30) {
    return {
      stage: "G3b",
      description: "Moderately to severely decreased",
      interpretation:
        "Moderate-severe kidney disease. Many medications require dose adjustment or are contraindicated. Nephrology referral recommended.",
      requiresDoseAdjustment: true,
    };
  }
  if (egfr >= 15) {
    return {
      stage: "G4",
      description: "Severely decreased",
      interpretation:
        "Severe kidney disease. Most renally-cleared medications require significant dose reduction. Prepare for renal replacement therapy.",
      requiresDoseAdjustment: true,
    };
  }
  return {
    stage: "G5",
    description: "Kidney failure",
    interpretation:
      "Kidney failure. Dialysis or transplant may be needed. Extreme caution with all medications. Many are contraindicated.",
    requiresDoseAdjustment: true,
  };
}
