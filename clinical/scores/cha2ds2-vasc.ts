/**
 * CHA₂DS₂-VASc Score Calculator
 * Estimates stroke risk in patients with atrial fibrillation.
 * Used to determine if anticoagulation therapy is indicated.
 * 
 * Reference: Lip GY, et al. Chest. 2010;137(2):263-272.
 * 
 * C - Congestive heart failure (1 point)
 * H - Hypertension (1 point)
 * A₂ - Age ≥75 (2 points)
 * D - Diabetes mellitus (1 point)
 * S₂ - Stroke/TIA/thromboembolism history (2 points)
 * V - Vascular disease (prior MI, PAD, aortic plaque) (1 point)
 * A - Age 65-74 (1 point)
 * Sc - Sex category (female) (1 point)
 */

export interface Cha2ds2VascInput {
  congestiveHeartFailure: boolean;
  hypertension: boolean;
  age: number;
  diabetesMellitus: boolean;
  strokeTiaHistory: boolean;
  vascularDisease: boolean;
  isFemale: boolean;
}

export interface Cha2ds2VascResult {
  score: number;
  strokeRiskPerYear: string;
  riskCategory: "low" | "moderate" | "high";
  interpretation: string;
  recommendation: string;
  anticoagulationIndicated: boolean;
  breakdown: { criterion: string; present: boolean; points: number }[];
}

export function calculateCha2ds2Vasc(input: Cha2ds2VascInput): Cha2ds2VascResult {
  const agePoints = input.age >= 75 ? 2 : input.age >= 65 ? 1 : 0;

  const breakdown = [
    { criterion: "Congestive heart failure", present: input.congestiveHeartFailure, points: input.congestiveHeartFailure ? 1 : 0 },
    { criterion: "Hypertension", present: input.hypertension, points: input.hypertension ? 1 : 0 },
    { criterion: "Age ≥75", present: input.age >= 75, points: input.age >= 75 ? 2 : 0 },
    { criterion: "Diabetes mellitus", present: input.diabetesMellitus, points: input.diabetesMellitus ? 1 : 0 },
    { criterion: "Stroke/TIA/thromboembolism", present: input.strokeTiaHistory, points: input.strokeTiaHistory ? 2 : 0 },
    { criterion: "Vascular disease (MI, PAD, aortic plaque)", present: input.vascularDisease, points: input.vascularDisease ? 1 : 0 },
    { criterion: "Age 65-74", present: input.age >= 65 && input.age < 75, points: input.age >= 65 && input.age < 75 ? 1 : 0 },
    { criterion: "Sex category (female)", present: input.isFemale, points: input.isFemale ? 1 : 0 },
  ];

  // Avoid double-counting age: remove the age 65-74 entry if age ≥75
  const filteredBreakdown = input.age >= 75
    ? breakdown.filter((b) => b.criterion !== "Age 65-74")
    : breakdown.filter((b) => b.criterion !== "Age ≥75" || input.age >= 75);

  const correctScore = [
    input.congestiveHeartFailure ? 1 : 0,
    input.hypertension ? 1 : 0,
    agePoints,
    input.diabetesMellitus ? 1 : 0,
    input.strokeTiaHistory ? 2 : 0,
    input.vascularDisease ? 1 : 0,
    input.isFemale ? 1 : 0,
  ].reduce((a, b) => a + b, 0);

  const { strokeRiskPerYear, riskCategory, interpretation, recommendation, anticoagulationIndicated } =
    classifyCha2ds2Vasc(correctScore, input.isFemale);

  return {
    score: correctScore,
    strokeRiskPerYear,
    riskCategory,
    interpretation,
    recommendation,
    anticoagulationIndicated,
    breakdown: filteredBreakdown,
  };
}

function classifyCha2ds2Vasc(score: number, isFemale: boolean) {
  // Stroke risk rates per year (approximate, from validation studies)
  const riskMap: Record<number, string> = {
    0: "0%", 1: "1.3%", 2: "2.2%", 3: "3.2%", 4: "4.0%",
    5: "6.7%", 6: "9.8%", 7: "9.6%", 8: "12.5%", 9: "15.2%",
  };

  const strokeRiskPerYear = riskMap[score] ?? ">15%";

  // For females, a score of 1 (sex alone) is considered low risk
  const adjustedScore = isFemale ? score - 1 : score;

  if (adjustedScore === 0) {
    return {
      strokeRiskPerYear,
      riskCategory: "low" as const,
      interpretation: "Low stroke risk. Anticoagulation is generally not recommended.",
      recommendation: "No anticoagulation therapy needed. Reassess risk factors periodically.",
      anticoagulationIndicated: false,
    };
  }
  if (adjustedScore === 1) {
    return {
      strokeRiskPerYear,
      riskCategory: "moderate" as const,
      interpretation: "Moderate stroke risk. Anticoagulation should be considered.",
      recommendation: "Consider oral anticoagulation (preferably DOAC over warfarin). Discuss risks and benefits with patient.",
      anticoagulationIndicated: true,
    };
  }
  return {
    strokeRiskPerYear,
    riskCategory: "high" as const,
    interpretation: `High stroke risk (${strokeRiskPerYear}/year). Anticoagulation is strongly recommended.`,
    recommendation: "Oral anticoagulation is recommended (DOAC preferred: apixaban, rivaroxaban, edoxaban, or dabigatran). If warfarin is used, target INR 2.0-3.0 with TTR >70%.",
    anticoagulationIndicated: true,
  };
}
