/**
 * HAS-BLED Score Calculator
 * Estimates the risk of major bleeding in patients on anticoagulation therapy.
 * 
 * Reference: Pisters R, et al. Chest. 2010;138(5):1093-1100.
 * 
 * Each criterion scores 1 point (max 9):
 * H - Hypertension (uncontrolled, systolic >160 mmHg)
 * A - Abnormal renal/liver function (1 point each)
 * S - Stroke history
 * B - Bleeding history or predisposition
 * L - Labile INR (unstable/high INRs, time in therapeutic range <60%)
 * E - Elderly (age >65)
 * D - Drugs (antiplatelet agents, NSAIDs) or alcohol (1 point each)
 */

export interface HasBledInput {
  hypertension: boolean;           // Uncontrolled, systolic >160 mmHg
  abnormalRenalFunction: boolean;  // Dialysis, transplant, Cr >2.26 mg/dL
  abnormalLiverFunction: boolean;  // Cirrhosis, bilirubin >2x normal, AST/ALT >3x normal
  strokeHistory: boolean;          // Previous stroke
  bleedingHistory: boolean;        // Prior major bleeding or predisposition
  labileInr: boolean;              // Unstable/high INRs, TTR <60%
  elderly: boolean;                // Age >65
  drugsAntiplatelet: boolean;      // Concomitant antiplatelet or NSAIDs
  alcoholUse: boolean;             // ≥8 drinks/week
}

export interface HasBledResult {
  score: number;
  riskCategory: "low" | "moderate" | "high";
  bleedingRiskPerYear: string;     // Approximate % risk
  interpretation: string;
  recommendation: string;
  breakdown: { criterion: string; present: boolean; points: number }[];
}

export function calculateHasBled(input: HasBledInput): HasBledResult {
  const breakdown = [
    { criterion: "Hypertension (uncontrolled, >160 mmHg)", present: input.hypertension, points: input.hypertension ? 1 : 0 },
    { criterion: "Abnormal renal function", present: input.abnormalRenalFunction, points: input.abnormalRenalFunction ? 1 : 0 },
    { criterion: "Abnormal liver function", present: input.abnormalLiverFunction, points: input.abnormalLiverFunction ? 1 : 0 },
    { criterion: "Stroke history", present: input.strokeHistory, points: input.strokeHistory ? 1 : 0 },
    { criterion: "Bleeding history/predisposition", present: input.bleedingHistory, points: input.bleedingHistory ? 1 : 0 },
    { criterion: "Labile INR (TTR <60%)", present: input.labileInr, points: input.labileInr ? 1 : 0 },
    { criterion: "Elderly (>65 years)", present: input.elderly, points: input.elderly ? 1 : 0 },
    { criterion: "Drugs (antiplatelet/NSAIDs)", present: input.drugsAntiplatelet, points: input.drugsAntiplatelet ? 1 : 0 },
    { criterion: "Alcohol use (≥8 drinks/week)", present: input.alcoholUse, points: input.alcoholUse ? 1 : 0 },
  ];

  const score = breakdown.reduce((sum, item) => sum + item.points, 0);

  const { riskCategory, bleedingRiskPerYear, interpretation, recommendation } =
    classifyHasBled(score);

  return {
    score,
    riskCategory,
    bleedingRiskPerYear,
    interpretation,
    recommendation,
    breakdown,
  };
}

function classifyHasBled(score: number) {
  if (score <= 1) {
    return {
      riskCategory: "low" as const,
      bleedingRiskPerYear: "1.0-3.4%",
      interpretation: "Low risk of major bleeding. Anticoagulation is generally safe.",
      recommendation: "Proceed with anticoagulation. Standard monitoring.",
    };
  }
  if (score === 2) {
    return {
      riskCategory: "moderate" as const,
      bleedingRiskPerYear: "4.1%",
      interpretation: "Moderate risk of major bleeding. Anticoagulation benefits likely outweigh risks in most patients.",
      recommendation: "Proceed with anticoagulation with closer monitoring. Address modifiable risk factors (hypertension, labile INR, drugs, alcohol).",
    };
  }
  return {
    riskCategory: "high" as const,
    bleedingRiskPerYear: score === 3 ? "5.8%" : score === 4 ? "8.9%" : ">9%",
    interpretation: `High risk of major bleeding (score ${score}). Careful risk-benefit analysis required before initiating anticoagulation.`,
    recommendation: "Consider alternatives to warfarin (DOACs may have lower bleeding risk). Address ALL modifiable risk factors. If anticoagulating, use lowest effective dose and monitor frequently. Consider gastric protection with PPI.",
  };
}
