import renalDosingData from "../../data/renal-dosing.json";

export interface RenalDoseAdjustment {
  medication: string;
  normalDose: string;
  adjustedDose: string;
  notes: string;
  egfrRange: string;
  requiresAdjustment: boolean;
  isContraindicated: boolean;
}

export interface RenalDosingResult {
  egfr: number;
  ckdStage: string;
  adjustments: RenalDoseAdjustment[];
  hasContraindications: boolean;
  summary: string;
}

/**
 * Given a list of medications and the patient's eGFR,
 * returns dose adjustments for each medication.
 */
export function getrenalDoseAdjustments(
  medications: string[],
  egfr: number,
): RenalDosingResult {
  const adjustments: RenalDoseAdjustment[] = [];
  const db = renalDosingData.medications;

  for (const med of medications) {
    const medLower = med.toLowerCase().trim();

    // Find medication in database
    const entry = db.find(
      (m) =>
        m.name.toLowerCase() === medLower ||
        m.genericName.toLowerCase() === medLower,
    );

    if (!entry) {
      adjustments.push({
        medication: med,
        normalDose: "Unknown",
        adjustedDose: "No renal dosing data available for this medication. Consult pharmacist.",
        notes: "Medication not found in renal dosing database.",
        egfrRange: `eGFR: ${egfr}`,
        requiresAdjustment: false,
        isContraindicated: false,
      });
      continue;
    }

    // Find the appropriate adjustment for the patient's eGFR
    const adjustment = entry.renalAdjustments.find(
      (adj) => egfr >= adj.egfrMin && egfr <= adj.egfrMax,
    );

    if (!adjustment) {
      adjustments.push({
        medication: med,
        normalDose: entry.normalDose,
        adjustedDose: "No specific adjustment found for this eGFR range. Consult pharmacist.",
        notes: "",
        egfrRange: `eGFR: ${egfr}`,
        requiresAdjustment: false,
        isContraindicated: false,
      });
      continue;
    }

    const isContraindicated = adjustment.dose.toUpperCase().includes("CONTRAINDICATED");
    const requiresAdjustment =
      isContraindicated ||
      adjustment.dose.toLowerCase().includes("reduce") ||
      adjustment.dose.toLowerCase().includes("caution") ||
      (adjustment.egfrMin < 60 && egfr < 60);

    adjustments.push({
      medication: med,
      normalDose: entry.normalDose,
      adjustedDose: adjustment.dose,
      notes: adjustment.notes,
      egfrRange: `eGFR ${adjustment.egfrMin}-${adjustment.egfrMax}`,
      requiresAdjustment,
      isContraindicated,
    });
  }

  const ckdStage = egfr >= 90 ? "G1" : egfr >= 60 ? "G2" : egfr >= 45 ? "G3a" : egfr >= 30 ? "G3b" : egfr >= 15 ? "G4" : "G5";
  const hasContraindications = adjustments.some((a) => a.isContraindicated);
  const adjustmentCount = adjustments.filter((a) => a.requiresAdjustment).length;

  const summary = hasContraindications
    ? `CRITICAL: ${adjustments.filter((a) => a.isContraindicated).map((a) => a.medication).join(", ")} is/are CONTRAINDICATED at eGFR ${egfr} (CKD ${ckdStage}). Immediate medication review required.`
    : adjustmentCount > 0
      ? `${adjustmentCount} medication(s) require dose adjustment for eGFR ${egfr} (CKD ${ckdStage}). Review adjusted doses before prescribing.`
      : `No dose adjustments needed for eGFR ${egfr} (CKD ${ckdStage}). Standard dosing is appropriate.`;

  return {
    egfr,
    ckdStage,
    adjustments,
    hasContraindications,
    summary,
  };
}
