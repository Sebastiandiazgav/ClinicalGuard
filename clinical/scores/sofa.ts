/**
 * SOFA Score (Sequential Organ Failure Assessment)
 * Predicts ICU mortality based on organ dysfunction.
 * Used for early detection of sepsis and multi-organ failure.
 * 
 * Reference: Vincent JL, et al. Intensive Care Med. 1996;22(7):707-710.
 * Sepsis-3: Singer M, et al. JAMA. 2016;315(8):801-810.
 * 
 * Evaluates 6 organ systems (0-4 points each, max 24):
 * - Respiration (PaO2/FiO2)
 * - Coagulation (Platelets)
 * - Liver (Bilirubin)
 * - Cardiovascular (MAP / Vasopressors)
 * - CNS (Glasgow Coma Scale)
 * - Renal (Creatinine / Urine output)
 */

export interface SofaInput {
  pao2fio2?: number;          // PaO2/FiO2 ratio (mmHg)
  onMechanicalVentilation?: boolean;
  platelets?: number;          // ×10³/µL
  bilirubin?: number;          // mg/dL
  meanArterialPressure?: number; // mmHg
  onVasopressors?: boolean;
  vasopressorDose?: "low" | "medium" | "high";
  glasgowComaScale?: number;  // 3-15
  creatinine?: number;         // mg/dL
  urineOutput24h?: number;     // mL/day
}

export interface SofaResult {
  totalScore: number;
  mortalityEstimate: string;
  sepsisLikely: boolean;
  organScores: {
    respiration: number;
    coagulation: number;
    liver: number;
    cardiovascular: number;
    cns: number;
    renal: number;
  };
  interpretation: string;
  recommendation: string;
  criticalOrgans: string[];
}

export function calculateSofa(input: SofaInput): SofaResult {
  const respiration = scoreRespiration(input.pao2fio2, input.onMechanicalVentilation);
  const coagulation = scoreCoagulation(input.platelets);
  const liver = scoreLiver(input.bilirubin);
  const cardiovascular = scoreCardiovascular(input.meanArterialPressure, input.onVasopressors, input.vasopressorDose);
  const cns = scoreCns(input.glasgowComaScale);
  const renal = scoreRenal(input.creatinine, input.urineOutput24h);

  const totalScore = respiration + coagulation + liver + cardiovascular + cns + renal;

  const criticalOrgans: string[] = [];
  if (respiration >= 3) criticalOrgans.push("Respiratory");
  if (coagulation >= 3) criticalOrgans.push("Coagulation");
  if (liver >= 3) criticalOrgans.push("Hepatic");
  if (cardiovascular >= 3) criticalOrgans.push("Cardiovascular");
  if (cns >= 3) criticalOrgans.push("Neurological");
  if (renal >= 3) criticalOrgans.push("Renal");

  const { mortalityEstimate, interpretation, recommendation } = classifySofa(totalScore, criticalOrgans);

  return {
    totalScore,
    mortalityEstimate,
    sepsisLikely: totalScore >= 2,
    organScores: { respiration, coagulation, liver, cardiovascular, cns, renal },
    interpretation,
    recommendation,
    criticalOrgans,
  };
}

function scoreRespiration(pao2fio2?: number, onVent?: boolean): number {
  if (!pao2fio2) return 0;
  if (pao2fio2 >= 400) return 0;
  if (pao2fio2 >= 300) return 1;
  if (pao2fio2 >= 200) return 2;
  if (pao2fio2 >= 100 && onVent) return 3;
  if (pao2fio2 < 100 && onVent) return 4;
  if (pao2fio2 >= 100) return 3;
  return 4;
}

function scoreCoagulation(platelets?: number): number {
  if (!platelets) return 0;
  if (platelets >= 150) return 0;
  if (platelets >= 100) return 1;
  if (platelets >= 50) return 2;
  if (platelets >= 20) return 3;
  return 4;
}

function scoreLiver(bilirubin?: number): number {
  if (!bilirubin) return 0;
  if (bilirubin < 1.2) return 0;
  if (bilirubin < 2.0) return 1;
  if (bilirubin < 6.0) return 2;
  if (bilirubin < 12.0) return 3;
  return 4;
}

function scoreCardiovascular(map?: number, onVasopressors?: boolean, dose?: string): number {
  if (onVasopressors) {
    if (dose === "high") return 4;
    if (dose === "medium") return 3;
    return 2;
  }
  if (!map) return 0;
  if (map >= 70) return 0;
  return 1;
}

function scoreCns(gcs?: number): number {
  if (!gcs) return 0;
  if (gcs >= 15) return 0;
  if (gcs >= 13) return 1;
  if (gcs >= 10) return 2;
  if (gcs >= 6) return 3;
  return 4;
}

function scoreRenal(creatinine?: number, urineOutput?: number): number {
  if (urineOutput !== undefined && urineOutput < 200) return 4;
  if (urineOutput !== undefined && urineOutput < 500) return 3;
  if (!creatinine) return 0;
  if (creatinine < 1.2) return 0;
  if (creatinine < 2.0) return 1;
  if (creatinine < 3.5) return 2;
  if (creatinine < 5.0) return 3;
  return 4;
}

function classifySofa(score: number, criticalOrgans: string[]) {
  if (score <= 1) {
    return {
      mortalityEstimate: "<3%",
      interpretation: "Minimal organ dysfunction. Low mortality risk.",
      recommendation: "Continue standard monitoring. Reassess if clinical status changes.",
    };
  }
  if (score <= 5) {
    return {
      mortalityEstimate: "~10%",
      interpretation: `Mild-moderate organ dysfunction. ${score >= 2 ? "Meets Sepsis-3 criteria if infection suspected." : ""}`,
      recommendation: "Investigate for infection source. Consider blood cultures, lactate level. Initiate early goal-directed therapy if sepsis suspected.",
    };
  }
  if (score <= 9) {
    return {
      mortalityEstimate: "~22%",
      interpretation: `Significant organ dysfunction. ${criticalOrgans.length > 0 ? `Critical organs: ${criticalOrgans.join(", ")}.` : ""} High risk of deterioration.`,
      recommendation: "ICU admission recommended. Aggressive resuscitation. Broad-spectrum antibiotics if infection suspected. Consider vasopressors if MAP <65. Continuous monitoring.",
    };
  }
  if (score <= 14) {
    return {
      mortalityEstimate: "~50%",
      interpretation: `Severe multi-organ dysfunction. ${criticalOrgans.length} organ systems critically affected. Very high mortality risk.`,
      recommendation: "ICU CRITICAL. Maximum supportive care. Consider goals-of-care discussion. Organ support (ventilation, dialysis, vasopressors) as indicated.",
    };
  }
  return {
    mortalityEstimate: ">80%",
    interpretation: "Catastrophic multi-organ failure. Extremely high mortality.",
    recommendation: "ICU EMERGENCY. All available organ support. Urgent goals-of-care and palliative care discussion with family. Consider limitations of treatment.",
  };
}
