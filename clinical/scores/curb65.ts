/**
 * CURB-65 Score for Community-Acquired Pneumonia
 * Assesses severity and guides disposition (outpatient vs hospital vs ICU).
 * 
 * Reference: Lim WS, et al. Thorax. 2003;58(5):377-382.
 * 
 * C - Confusion (new onset)
 * U - Urea/BUN >7 mmol/L (or BUN >19 mg/dL)
 * R - Respiratory rate ≥30/min
 * B - Blood pressure (systolic <90 or diastolic ≤60)
 * 65 - Age ≥65
 */

export interface Curb65Input {
  confusion: boolean;
  bun?: number;           // mg/dL (>19 = 1 point) or urea mmol/L (>7 = 1 point)
  bunUnit?: "mg/dL" | "mmol/L";
  respiratoryRate?: number;
  systolicBp?: number;
  diastolicBp?: number;
  age: number;
}

export interface Curb65Result {
  score: number;
  mortality30Day: string;
  riskCategory: "low" | "moderate" | "high" | "severe";
  disposition: string;
  recommendation: string;
  breakdown: { criterion: string; present: boolean; points: number }[];
}

export function calculateCurb65(input: Curb65Input): Curb65Result {
  const bunThreshold = input.bunUnit === "mmol/L" ? 7 : 19;
  const bunElevated = input.bun !== undefined && input.bun > bunThreshold;
  const rrElevated = input.respiratoryRate !== undefined && input.respiratoryRate >= 30;
  const bpLow = (input.systolicBp !== undefined && input.systolicBp < 90) ||
    (input.diastolicBp !== undefined && input.diastolicBp <= 60);
  const ageElevated = input.age >= 65;

  const breakdown = [
    { criterion: "Confusion (new onset)", present: input.confusion, points: input.confusion ? 1 : 0 },
    { criterion: `BUN >${bunThreshold} ${input.bunUnit ?? "mg/dL"}`, present: bunElevated, points: bunElevated ? 1 : 0 },
    { criterion: "Respiratory rate ≥30/min", present: rrElevated, points: rrElevated ? 1 : 0 },
    { criterion: "BP: systolic <90 or diastolic ≤60", present: bpLow, points: bpLow ? 1 : 0 },
    { criterion: "Age ≥65", present: ageElevated, points: ageElevated ? 1 : 0 },
  ];

  const score = breakdown.reduce((sum, b) => sum + b.points, 0);
  const { mortality30Day, riskCategory, disposition, recommendation } = classifyCurb65(score);

  return { score, mortality30Day, riskCategory, disposition, recommendation, breakdown };
}

function classifyCurb65(score: number) {
  if (score === 0) {
    return {
      mortality30Day: "0.6%",
      riskCategory: "low" as const,
      disposition: "Outpatient treatment",
      recommendation: "Low risk. Consider outpatient treatment with oral antibiotics. Follow-up in 48-72 hours.",
    };
  }
  if (score === 1) {
    return {
      mortality30Day: "2.7%",
      riskCategory: "low" as const,
      disposition: "Outpatient or short inpatient observation",
      recommendation: "Low risk. Outpatient treatment possible if good social support. Consider short observation if concerns.",
    };
  }
  if (score === 2) {
    return {
      mortality30Day: "6.8%",
      riskCategory: "moderate" as const,
      disposition: "Hospital admission (ward)",
      recommendation: "Moderate risk. Hospital admission recommended. IV antibiotics. Monitor for deterioration.",
    };
  }
  if (score === 3) {
    return {
      mortality30Day: "14.0%",
      riskCategory: "high" as const,
      disposition: "Hospital admission — consider ICU",
      recommendation: "High risk. Hospital admission required. Consider ICU/HDU if respiratory failure or hemodynamic instability.",
    };
  }
  return {
    mortality30Day: "27.8%",
    riskCategory: "severe" as const,
    disposition: "ICU admission",
    recommendation: "Very high risk. ICU admission. Aggressive management. Consider intubation if respiratory failure. Broad-spectrum antibiotics. Vasopressors if needed.",
  };
}
