/**
 * HEART Score for Chest Pain
 * Risk stratification for acute coronary syndrome (ACS) in emergency department.
 * Determines which patients can be safely discharged vs need further workup.
 * 
 * Reference: Six AJ, et al. Neth Heart J. 2008;16(6):191-196.
 * Validation: Backus BE, et al. Int J Cardiol. 2013;168(3):2153-2158.
 * 
 * H - History (0-2)
 * E - ECG (0-2)
 * A - Age (0-2)
 * R - Risk factors (0-2)
 * T - Troponin (0-2)
 */

export interface HeartInput {
  historyScore: 0 | 1 | 2;       // 0=slightly suspicious, 1=moderately, 2=highly suspicious
  ecgScore: 0 | 1 | 2;           // 0=normal, 1=non-specific repolarization, 2=significant ST deviation
  age: number;                     // years
  riskFactors: number;             // count of: HTN, DM, hyperlipidemia, obesity, smoking, family hx, prior CAD
  troponinScore: 0 | 1 | 2;      // 0=normal, 1=1-3x ULN, 2=>3x ULN
}

export interface HeartResult {
  score: number;
  riskCategory: "low" | "moderate" | "high";
  maceRisk6Weeks: string;
  interpretation: string;
  recommendation: string;
  disposition: string;
  breakdown: { criterion: string; score: number; maxScore: number }[];
}

export function calculateHeart(input: HeartInput): HeartResult {
  const ageScore = input.age >= 65 ? 2 : input.age >= 45 ? 1 : 0;
  const riskFactorScore = input.riskFactors >= 3 ? 2 : input.riskFactors >= 1 ? 1 : 0;

  const breakdown = [
    { criterion: "History", score: input.historyScore, maxScore: 2 },
    { criterion: "ECG", score: input.ecgScore, maxScore: 2 },
    { criterion: "Age", score: ageScore, maxScore: 2 },
    { criterion: "Risk Factors", score: riskFactorScore, maxScore: 2 },
    { criterion: "Troponin", score: input.troponinScore, maxScore: 2 },
  ];

  const score = input.historyScore + input.ecgScore + ageScore + riskFactorScore + input.troponinScore;

  const { riskCategory, maceRisk6Weeks, interpretation, recommendation, disposition } =
    classifyHeart(score);

  return {
    score,
    riskCategory,
    maceRisk6Weeks,
    interpretation,
    recommendation,
    disposition,
    breakdown,
  };
}

function classifyHeart(score: number) {
  if (score <= 3) {
    return {
      riskCategory: "low" as const,
      maceRisk6Weeks: "0.9-1.7%",
      interpretation: "Low risk for major adverse cardiac events. Safe for early discharge.",
      recommendation: "Consider discharge with outpatient follow-up. No urgent cardiac workup needed. Provide return precautions.",
      disposition: "DISCHARGE with follow-up in 72 hours",
    };
  }
  if (score <= 6) {
    return {
      riskCategory: "moderate" as const,
      maceRisk6Weeks: "12-16.6%",
      interpretation: "Moderate risk for MACE. Requires further evaluation before disposition.",
      recommendation: "Observation unit admission. Serial troponins (0h, 3h, 6h). Consider stress testing or CT coronary angiography. Cardiology consultation.",
      disposition: "ADMIT to observation / chest pain unit",
    };
  }
  return {
    riskCategory: "high" as const,
    maceRisk6Weeks: "50-65%",
    interpretation: "High risk for MACE. Urgent cardiac intervention likely needed.",
    recommendation: "Admit to cardiology/CCU. Urgent cardiology consultation. Consider early invasive strategy (cardiac catheterization). Dual antiplatelet therapy. Anticoagulation per ACS protocol.",
    disposition: "ADMIT to CCU / Cardiology",
  };
}
