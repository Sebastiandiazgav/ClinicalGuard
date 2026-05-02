import interactionsData from "../../data/drug-interactions.json";

export type Severity = "contraindicated" | "severe" | "moderate" | "mild";

export interface DrugInteraction {
  drug1: string;
  drug2: string;
  severity: Severity;
  mechanism: string;
  clinicalEffect: string;
  recommendation: string;
  alternatives: string[];
  evidenceLevel: string;
}

export interface InteractionCheckResult {
  hasInteractions: boolean;
  totalInteractions: number;
  criticalCount: number;
  severeCount: number;
  moderateCount: number;
  interactions: DrugInteraction[];
  overallRiskLevel: "safe" | "caution" | "warning" | "danger";
  summary: string;
}

/**
 * Normalizes a drug name for matching.
 * Handles common variations, brand names, and FHIR coding display values.
 */
function normalizeDrugName(name: string): string[] {
  const lower = name.toLowerCase().trim();

  // Map brand names and variations to generic names
  const brandToGeneric: Record<string, string[]> = {
    coumadin: ["warfarin"],
    jantoven: ["warfarin"],
    glucophage: ["metformin"],
    prinivil: ["lisinopril"],
    zestril: ["lisinopril"],
    norvasc: ["amlodipine"],
    plavix: ["clopidogrel"],
    prilosec: ["omeprazole"],
    nexium: ["esomeprazole"],
    protonix: ["pantoprazole"],
    xarelto: ["rivaroxaban"],
    eliquis: ["apixaban"],
    pradaxa: ["dabigatran"],
    lovenox: ["enoxaparin"],
    neurontin: ["gabapentin"],
    cipro: ["ciprofloxacin"],
    motrin: ["ibuprofen"],
    advil: ["ibuprofen"],
    tylenol: ["acetaminophen"],
    toradol: ["ketorolac"],
    cordarone: ["amiodarone"],
    pacerone: ["amiodarone"],
    diflucan: ["fluconazole"],
    lanoxin: ["digoxin"],
    ultram: ["tramadol"],
    zocor: ["simvastatin"],
    lipitor: ["atorvastatin"],
    crestor: ["rosuvastatin"],
    zyloprim: ["allopurinol"],
  };

  // SSRI class mapping
  const ssriNames = [
    "fluoxetine", "sertraline", "paroxetine", "citalopram",
    "escitalopram", "fluvoxamine", "prozac", "zoloft",
    "paxil", "celexa", "lexapro",
  ];

  const results = [lower];

  // Add generic name if brand name found
  const genericNames = brandToGeneric[lower];
  if (genericNames) {
    results.push(...genericNames);
  }

  // Check if it's an SSRI
  if (ssriNames.includes(lower)) {
    results.push("ssri");
  }

  return results;
}

/**
 * Checks for drug-drug interactions between a list of medications.
 * Returns all found interactions sorted by severity.
 */
export function checkDrugInteractions(
  medications: string[],
  conditions?: string[],
): InteractionCheckResult {
  const interactions: DrugInteraction[] = [];
  const db = interactionsData.interactions;

  // Check drug-drug interactions
  for (let i = 0; i < medications.length; i++) {
    for (let j = i + 1; j < medications.length; j++) {
      const drug1Names = normalizeDrugName(medications[i]!);
      const drug2Names = normalizeDrugName(medications[j]!);

      for (const entry of db) {
        const match =
          (drug1Names.includes(entry.drug1) && drug2Names.includes(entry.drug2)) ||
          (drug1Names.includes(entry.drug2) && drug2Names.includes(entry.drug1));

        if (match) {
          interactions.push({
            drug1: medications[i]!,
            drug2: medications[j]!,
            severity: entry.severity as Severity,
            mechanism: entry.mechanism,
            clinicalEffect: entry.clinicalEffect,
            recommendation: entry.recommendation,
            alternatives: entry.alternatives,
            evidenceLevel: entry.evidenceLevel,
          });
        }
      }
    }
  }

  // Check drug-condition interactions (e.g., ketorolac + renal_impairment)
  if (conditions) {
    for (const med of medications) {
      const medNames = normalizeDrugName(med);
      for (const condition of conditions) {
        const condNorm = condition.toLowerCase().trim();
        for (const entry of db) {
          const match =
            (medNames.includes(entry.drug1) && entry.drug2 === condNorm) ||
            (medNames.includes(entry.drug2) && entry.drug1 === condNorm);

          if (match) {
            interactions.push({
              drug1: med,
              drug2: condition,
              severity: entry.severity as Severity,
              mechanism: entry.mechanism,
              clinicalEffect: entry.clinicalEffect,
              recommendation: entry.recommendation,
              alternatives: entry.alternatives,
              evidenceLevel: entry.evidenceLevel,
            });
          }
        }
      }
    }
  }

  // Sort by severity
  const severityOrder: Record<Severity, number> = {
    contraindicated: 0,
    severe: 1,
    moderate: 2,
    mild: 3,
  };
  interactions.sort(
    (a, b) => severityOrder[a.severity] - severityOrder[b.severity],
  );

  const criticalCount = interactions.filter((i) => i.severity === "contraindicated").length;
  const severeCount = interactions.filter((i) => i.severity === "severe").length;
  const moderateCount = interactions.filter((i) => i.severity === "moderate").length;

  let overallRiskLevel: InteractionCheckResult["overallRiskLevel"] = "safe";
  if (criticalCount > 0) overallRiskLevel = "danger";
  else if (severeCount > 0) overallRiskLevel = "warning";
  else if (moderateCount > 0) overallRiskLevel = "caution";

  const summary = interactions.length === 0
    ? "No drug interactions detected among the provided medications."
    : `Found ${interactions.length} interaction(s): ${criticalCount} contraindicated, ${severeCount} severe, ${moderateCount} moderate. ${
        criticalCount > 0
          ? "IMMEDIATE ACTION REQUIRED: Contraindicated combinations detected."
          : severeCount > 0
            ? "WARNING: Severe interactions detected. Review and adjust therapy."
            : "Caution advised. Monitor patient closely."
      }`;

  return {
    hasInteractions: interactions.length > 0,
    totalInteractions: interactions.length,
    criticalCount,
    severeCount,
    moderateCount,
    interactions,
    overallRiskLevel,
    summary,
  };
}
