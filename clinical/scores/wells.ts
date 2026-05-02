/**
 * Wells Score for Pulmonary Embolism (PE)
 * Estimates the probability of pulmonary embolism.
 * 
 * Reference: Wells PS, et al. Thromb Haemost. 2000;83(3):416-420.
 * 
 * Clinical signs of DVT (3 points)
 * PE is #1 diagnosis or equally likely (3 points)
 * Heart rate >100 bpm (1.5 points)
 * Immobilization ≥3 days or surgery in past 4 weeks (1.5 points)
 * Previous PE or DVT (1.5 points)
 * Hemoptysis (1 point)
 * Malignancy (treatment within 6 months or palliative) (1 point)
 */

export interface WellsPeInput {
  clinicalSignsDvt: boolean;
  peIsTopDiagnosis: boolean;
  heartRateOver100: boolean;
  immobilizationOrSurgery: boolean;
  previousPeDvt: boolean;
  hemoptysis: boolean;
  malignancy: boolean;
}

export interface WellsPeResult {
  score: number;
  riskCategory: "low" | "moderate" | "high";
  peProbability: string;
  interpretation: string;
  recommendation: string;
  breakdown: { criterion: string; present: boolean; points: number }[];
}

export function calculateWellsPe(input: WellsPeInput): WellsPeResult {
  const breakdown = [
    { criterion: "Clinical signs/symptoms of DVT", present: input.clinicalSignsDvt, points: input.clinicalSignsDvt ? 3 : 0 },
    { criterion: "PE is #1 diagnosis or equally likely", present: input.peIsTopDiagnosis, points: input.peIsTopDiagnosis ? 3 : 0 },
    { criterion: "Heart rate >100 bpm", present: input.heartRateOver100, points: input.heartRateOver100 ? 1.5 : 0 },
    { criterion: "Immobilization ≥3 days or surgery in past 4 weeks", present: input.immobilizationOrSurgery, points: input.immobilizationOrSurgery ? 1.5 : 0 },
    { criterion: "Previous PE or DVT", present: input.previousPeDvt, points: input.previousPeDvt ? 1.5 : 0 },
    { criterion: "Hemoptysis", present: input.hemoptysis, points: input.hemoptysis ? 1 : 0 },
    { criterion: "Malignancy (active or treated within 6 months)", present: input.malignancy, points: input.malignancy ? 1 : 0 },
  ];

  const score = breakdown.reduce((sum, item) => sum + item.points, 0);

  const { riskCategory, peProbability, interpretation, recommendation } =
    classifyWellsPe(score);

  return {
    score,
    riskCategory,
    peProbability,
    interpretation,
    recommendation,
    breakdown,
  };
}

function classifyWellsPe(score: number) {
  if (score <= 1) {
    return {
      riskCategory: "low" as const,
      peProbability: "~1.3%",
      interpretation: "Low probability of PE. D-dimer can safely rule out PE.",
      recommendation: "Order D-dimer. If negative, PE is effectively ruled out. If positive, proceed to CT pulmonary angiography (CTPA).",
    };
  }
  if (score <= 4) {
    return {
      riskCategory: "moderate" as const,
      peProbability: "~16.2%",
      interpretation: "Moderate probability of PE. Further workup is needed.",
      recommendation: "Order D-dimer. If negative, PE is unlikely. If positive, proceed to CTPA. Consider clinical context.",
    };
  }
  return {
    riskCategory: "high" as const,
    peProbability: "~40.6%",
    interpretation: "High probability of PE. Imaging is required regardless of D-dimer.",
    recommendation: "Proceed directly to CT pulmonary angiography (CTPA). Do NOT rely on D-dimer alone. Consider empiric anticoagulation while awaiting imaging if clinical suspicion is high.",
  };
}
