/**
 * NEWS2 (National Early Warning Score 2)
 * Standardized early warning score used to detect clinical deterioration.
 * Recommended by NHS England for all acute hospital patients.
 * 
 * Reference: Royal College of Physicians, 2017.
 * 
 * Parameters scored (0-3 each):
 * - Respiration rate
 * - SpO2 (Scale 1 or Scale 2 for COPD)
 * - Systolic BP
 * - Pulse rate
 * - Consciousness (AVPU)
 * - Temperature
 * + 2 points if on supplemental O2
 */

export interface News2Input {
  respirationRate?: number;
  spo2?: number;
  isOnSupplementalO2?: boolean;
  systolicBp?: number;
  pulseRate?: number;
  consciousness: "alert" | "confusion" | "voice" | "pain" | "unresponsive";
  temperature?: number;
  useScale2?: boolean; // Scale 2 for patients with hypercapnic respiratory failure (COPD)
}

export interface News2Result {
  totalScore: number;
  clinicalRisk: "low" | "low-medium" | "medium" | "high";
  responseRequired: string;
  interpretation: string;
  recommendation: string;
  breakdown: { parameter: string; value: string; score: number }[];
}

export function calculateNews2(input: News2Input): News2Result {
  const breakdown: { parameter: string; value: string; score: number }[] = [];

  // Respiration Rate
  const rrScore = scoreRespirationRate(input.respirationRate);
  breakdown.push({ parameter: "Respiration Rate", value: input.respirationRate ? `${input.respirationRate}/min` : "N/A", score: rrScore });

  // SpO2
  const spo2Score = input.useScale2
    ? scoreSpO2Scale2(input.spo2)
    : scoreSpO2Scale1(input.spo2);
  breakdown.push({ parameter: `SpO2 (Scale ${input.useScale2 ? "2" : "1"})`, value: input.spo2 ? `${input.spo2}%` : "N/A", score: spo2Score });

  // Supplemental O2
  const o2Score = input.isOnSupplementalO2 ? 2 : 0;
  breakdown.push({ parameter: "Supplemental O2", value: input.isOnSupplementalO2 ? "Yes" : "No", score: o2Score });

  // Systolic BP
  const bpScore = scoreSystolicBp(input.systolicBp);
  breakdown.push({ parameter: "Systolic BP", value: input.systolicBp ? `${input.systolicBp} mmHg` : "N/A", score: bpScore });

  // Pulse
  const pulseScore = scorePulse(input.pulseRate);
  breakdown.push({ parameter: "Pulse Rate", value: input.pulseRate ? `${input.pulseRate} bpm` : "N/A", score: pulseScore });

  // Consciousness
  const consScore = input.consciousness === "alert" ? 0 : 3;
  breakdown.push({ parameter: "Consciousness", value: input.consciousness.toUpperCase(), score: consScore });

  // Temperature
  const tempScore = scoreTemperature(input.temperature);
  breakdown.push({ parameter: "Temperature", value: input.temperature ? `${input.temperature}°C` : "N/A", score: tempScore });

  const totalScore = rrScore + spo2Score + o2Score + bpScore + pulseScore + consScore + tempScore;

  // Check for single parameter score of 3 (triggers medium response)
  const hasExtremeSingle = breakdown.some((b) => b.score === 3);

  const { clinicalRisk, responseRequired, interpretation, recommendation } =
    classifyNews2(totalScore, hasExtremeSingle);

  return {
    totalScore,
    clinicalRisk,
    responseRequired,
    interpretation,
    recommendation,
    breakdown,
  };
}

function scoreRespirationRate(rr?: number): number {
  if (!rr) return 0;
  if (rr <= 8) return 3;
  if (rr <= 11) return 1;
  if (rr <= 20) return 0;
  if (rr <= 24) return 2;
  return 3;
}

function scoreSpO2Scale1(spo2?: number): number {
  if (!spo2) return 0;
  if (spo2 <= 91) return 3;
  if (spo2 <= 93) return 2;
  if (spo2 <= 95) return 1;
  return 0;
}

function scoreSpO2Scale2(spo2?: number): number {
  if (!spo2) return 0;
  if (spo2 <= 83) return 3;
  if (spo2 <= 85) return 2;
  if (spo2 <= 87) return 1;
  if (spo2 <= 92) return 0;
  if (spo2 <= 94) return 1;
  if (spo2 <= 96) return 2;
  return 3; // >96% on O2 in COPD patient is concerning
}

function scoreSystolicBp(sbp?: number): number {
  if (!sbp) return 0;
  if (sbp <= 90) return 3;
  if (sbp <= 100) return 2;
  if (sbp <= 110) return 1;
  if (sbp <= 219) return 0;
  return 3;
}

function scorePulse(pulse?: number): number {
  if (!pulse) return 0;
  if (pulse <= 40) return 3;
  if (pulse <= 50) return 1;
  if (pulse <= 90) return 0;
  if (pulse <= 110) return 1;
  if (pulse <= 130) return 2;
  return 3;
}

function scoreTemperature(temp?: number): number {
  if (!temp) return 0;
  if (temp <= 35.0) return 3;
  if (temp <= 36.0) return 1;
  if (temp <= 38.0) return 0;
  if (temp <= 39.0) return 1;
  return 2;
}

function classifyNews2(score: number, hasExtremeSingle: boolean) {
  if (score >= 7) {
    return {
      clinicalRisk: "high" as const,
      responseRequired: "Emergency response — immediate senior clinician assessment",
      interpretation: "HIGH clinical risk. Patient is at significant risk of deterioration, cardiac arrest, or death.",
      recommendation: "URGENT: Senior clinician review within 15 minutes. Consider ICU/HDU transfer. Continuous monitoring. Activate rapid response team if not already done.",
    };
  }
  if (score >= 5 || hasExtremeSingle) {
    return {
      clinicalRisk: "medium" as const,
      responseRequired: "Urgent response — clinician review within 30 minutes",
      interpretation: "MEDIUM clinical risk. Patient showing signs of clinical deterioration.",
      recommendation: "Urgent clinician assessment within 30 minutes. Increase monitoring frequency to minimum hourly. Consider escalation to senior clinician or critical care outreach.",
    };
  }
  if (score >= 1 && score <= 4) {
    return {
      clinicalRisk: "low-medium" as const,
      responseRequired: "Ward-based response — nurse assessment, inform clinician",
      interpretation: "Low-medium clinical risk. Some physiological abnormality detected.",
      recommendation: "Registered nurse assessment. Decide if increased monitoring frequency needed. Inform responsible clinician.",
    };
  }
  return {
    clinicalRisk: "low" as const,
    responseRequired: "Routine monitoring — minimum every 12 hours",
    interpretation: "Low clinical risk. Vital signs within normal parameters.",
    recommendation: "Continue routine monitoring every 12 hours (or per local policy).",
  };
}
