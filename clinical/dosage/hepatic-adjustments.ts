/**
 * Hepatic Dose Adjustments
 * Provides medication dose adjustments based on liver function.
 * Uses Child-Pugh classification (A, B, C) for severity grading.
 * 
 * Child-Pugh A = Mild (5-6 points)
 * Child-Pugh B = Moderate (7-9 points)
 * Child-Pugh C = Severe (10-15 points)
 */

export type ChildPughClass = "A" | "B" | "C" | "unknown";

export interface HepaticDoseAdjustment {
  medication: string;
  normalDose: string;
  adjustedDose: string;
  childPughClass: ChildPughClass;
  notes: string;
  isContraindicated: boolean;
  requiresAdjustment: boolean;
}

export interface HepaticDosingResult {
  childPughClass: ChildPughClass;
  adjustments: HepaticDoseAdjustment[];
  hasContraindications: boolean;
  summary: string;
}

interface HepaticDosingEntry {
  name: string;
  normalDose: string;
  adjustments: {
    childPugh: ChildPughClass;
    dose: string;
    notes: string;
  }[];
}

const hepaticDosingDatabase: HepaticDosingEntry[] = [
  {
    name: "acetaminophen",
    normalDose: "500-1000mg every 4-6 hours (max 4g/day)",
    adjustments: [
      { childPugh: "A", dose: "Reduce max to 2g/day. Avoid prolonged use.", notes: "Hepatotoxic at high doses." },
      { childPugh: "B", dose: "Reduce max to 2g/day. Short courses only (≤3 days).", notes: "Increased hepatotoxicity risk. Monitor LFTs." },
      { childPugh: "C", dose: "AVOID. Use only if no alternatives, max 1g/day for ≤2 days.", notes: "Severe hepatotoxicity risk. Consider alternative analgesics." },
    ],
  },
  {
    name: "metformin",
    normalDose: "500-1000mg BID",
    adjustments: [
      { childPugh: "A", dose: "Use with caution. Standard dosing acceptable.", notes: "Monitor for lactic acidosis." },
      { childPugh: "B", dose: "AVOID. Increased lactic acidosis risk due to impaired lactate clearance.", notes: "Switch to insulin or other agents." },
      { childPugh: "C", dose: "CONTRAINDICATED.", notes: "High risk of fatal lactic acidosis." },
    ],
  },
  {
    name: "warfarin",
    normalDose: "Individualized (2-10mg daily)",
    adjustments: [
      { childPugh: "A", dose: "Reduce initial dose by 25%. Monitor INR closely.", notes: "Reduced synthesis of clotting factors." },
      { childPugh: "B", dose: "Reduce initial dose by 50%. INR monitoring every 2-3 days.", notes: "Significantly impaired clotting factor synthesis. High bleeding risk." },
      { childPugh: "C", dose: "AVOID if possible. Extreme bleeding risk.", notes: "Consider alternative anticoagulation strategies. Consult hematology." },
    ],
  },
  {
    name: "simvastatin",
    normalDose: "10-40mg daily",
    adjustments: [
      { childPugh: "A", dose: "Use with caution. Start at lowest dose (10mg).", notes: "Monitor LFTs at baseline and 12 weeks." },
      { childPugh: "B", dose: "CONTRAINDICATED.", notes: "Active liver disease. Risk of hepatotoxicity and rhabdomyolysis." },
      { childPugh: "C", dose: "CONTRAINDICATED.", notes: "Active liver disease." },
    ],
  },
  {
    name: "atorvastatin",
    normalDose: "10-80mg daily",
    adjustments: [
      { childPugh: "A", dose: "Use with caution. Start at 10mg.", notes: "Monitor LFTs." },
      { childPugh: "B", dose: "CONTRAINDICATED.", notes: "Active liver disease." },
      { childPugh: "C", dose: "CONTRAINDICATED.", notes: "Active liver disease." },
    ],
  },
  {
    name: "diazepam",
    normalDose: "2-10mg BID-TID",
    adjustments: [
      { childPugh: "A", dose: "Reduce dose by 50%. Extended intervals.", notes: "Prolonged half-life in liver disease." },
      { childPugh: "B", dose: "Reduce dose by 75%. Use short-acting alternatives (lorazepam, oxazepam).", notes: "Very prolonged half-life. Accumulation risk." },
      { childPugh: "C", dose: "AVOID. Use lorazepam or oxazepam if benzodiazepine needed.", notes: "Risk of precipitating hepatic encephalopathy." },
    ],
  },
  {
    name: "opioids",
    normalDose: "Varies by agent",
    adjustments: [
      { childPugh: "A", dose: "Reduce dose by 25-50%. Extend intervals.", notes: "Impaired metabolism. Monitor for sedation." },
      { childPugh: "B", dose: "Reduce dose by 50-75%. Use with extreme caution.", notes: "High risk of accumulation and encephalopathy." },
      { childPugh: "C", dose: "AVOID if possible. If needed, use lowest dose with extended intervals.", notes: "Can precipitate hepatic encephalopathy. Consider non-opioid alternatives." },
    ],
  },
  {
    name: "methotrexate",
    normalDose: "7.5-25mg weekly",
    adjustments: [
      { childPugh: "A", dose: "Use with caution. Monitor LFTs monthly.", notes: "Hepatotoxic. Avoid alcohol completely." },
      { childPugh: "B", dose: "CONTRAINDICATED.", notes: "Significant hepatotoxicity risk." },
      { childPugh: "C", dose: "CONTRAINDICATED.", notes: "Will worsen liver disease." },
    ],
  },
  {
    name: "amiodarone",
    normalDose: "200-400mg daily (maintenance)",
    adjustments: [
      { childPugh: "A", dose: "Use with caution. Monitor LFTs every 3 months.", notes: "Can cause hepatotoxicity (1-3% of patients)." },
      { childPugh: "B", dose: "AVOID if possible. If essential, reduce dose and monitor LFTs monthly.", notes: "Increased hepatotoxicity risk." },
      { childPugh: "C", dose: "CONTRAINDICATED.", notes: "Unacceptable hepatotoxicity risk." },
    ],
  },
  {
    name: "fluconazole",
    normalDose: "150-400mg daily",
    adjustments: [
      { childPugh: "A", dose: "Standard dosing. Monitor LFTs.", notes: "" },
      { childPugh: "B", dose: "Reduce dose by 50%. Monitor LFTs weekly.", notes: "Hepatically metabolized." },
      { childPugh: "C", dose: "AVOID. Use alternative antifungal (micafungin, anidulafungin).", notes: "High hepatotoxicity risk." },
    ],
  },
];

/**
 * Get hepatic dose adjustments for a list of medications.
 */
export function getHepaticDoseAdjustments(
  medications: string[],
  childPughClass: ChildPughClass,
): HepaticDosingResult {
  const adjustments: HepaticDoseAdjustment[] = [];

  for (const med of medications) {
    const medLower = med.toLowerCase().trim();
    const entry = hepaticDosingDatabase.find(
      (m) => medLower.includes(m.name) || m.name.includes(medLower),
    );

    if (!entry) {
      adjustments.push({
        medication: med,
        normalDose: "Unknown",
        adjustedDose: "No hepatic dosing data available. Consult pharmacist or hepatologist.",
        childPughClass,
        notes: "Medication not in hepatic dosing database.",
        isContraindicated: false,
        requiresAdjustment: false,
      });
      continue;
    }

    const adjustment = entry.adjustments.find((a) => a.childPugh === childPughClass);
    if (!adjustment) {
      adjustments.push({
        medication: med,
        normalDose: entry.normalDose,
        adjustedDose: "No specific adjustment for this Child-Pugh class.",
        childPughClass,
        notes: "",
        isContraindicated: false,
        requiresAdjustment: false,
      });
      continue;
    }

    const isContraindicated = adjustment.dose.toUpperCase().includes("CONTRAINDICATED");
    const requiresAdjustment =
      isContraindicated ||
      adjustment.dose.toLowerCase().includes("reduce") ||
      adjustment.dose.toLowerCase().includes("avoid") ||
      adjustment.dose.toLowerCase().includes("caution");

    adjustments.push({
      medication: med,
      normalDose: entry.normalDose,
      adjustedDose: adjustment.dose,
      childPughClass,
      notes: adjustment.notes,
      isContraindicated,
      requiresAdjustment,
    });
  }

  const hasContraindications = adjustments.some((a) => a.isContraindicated);
  const adjustmentCount = adjustments.filter((a) => a.requiresAdjustment).length;

  const summary = hasContraindications
    ? `CRITICAL: ${adjustments.filter((a) => a.isContraindicated).map((a) => a.medication).join(", ")} is/are CONTRAINDICATED in Child-Pugh ${childPughClass} liver disease. Immediate medication review required.`
    : adjustmentCount > 0
      ? `${adjustmentCount} medication(s) require hepatic dose adjustment for Child-Pugh ${childPughClass}. Review adjusted doses.`
      : `No hepatic dose adjustments needed for Child-Pugh ${childPughClass}.`;

  return {
    childPughClass,
    adjustments,
    hasContraindications,
    summary,
  };
}
