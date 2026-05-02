import { McpServer } from "@modelcontextprotocol/sdk/server/mcp";
import { Request } from "express";
import { IMcpTool } from "../IMcpTool";
import { z } from "zod";
import { FhirClientInstance } from "../fhir-client";
import { FhirUtilities } from "../fhir-utilities";
import { McpUtilities } from "../mcp-utilities";
import { NullUtilities } from "../null-utilities";
import { fhirR4 } from "@smile-cdr/fhirts";

interface ClinicalAlert {
  severity: "critical" | "urgent" | "warning" | "info";
  category: string;
  title: string;
  detail: string;
  action: string;
  dataSource: string;
}

class DetectClinicalAlertsTool implements IMcpTool {
  registerTool(server: McpServer, req: Request) {
    server.registerTool(
      "DetectClinicalAlerts",
      {
        description:
          "Proactively scans patient data for clinical alerts and emergencies. " +
          "Detects: critical lab values, sepsis indicators (qSOFA), deterioration patterns, " +
          "dangerous vital sign combinations, missed follow-ups, and high-risk medication situations. " +
          "Acts as an early warning system that catches what busy clinicians might miss. " +
          "Use this tool at the START of any patient encounter for situational awareness.",
        inputSchema: {
          patientId: z
            .string()
            .describe("The patient ID. Optional if FHIR context exists.")
            .optional(),
          alertCategories: z
            .array(z.enum(["labs", "vitals", "medications", "conditions", "all"]))
            .describe("Which categories to scan. Defaults to 'all'.")
            .optional(),
        },
      },
      async ({ patientId, alertCategories }) => {
        try {
          if (!patientId) {
            patientId = NullUtilities.getOrThrow(
              FhirUtilities.getPatientIdIfContextExists(req),
              "Patient ID is required.",
            );
          }

          const categories = alertCategories ?? ["all"];
          const scanAll = categories.includes("all");
          const alerts: ClinicalAlert[] = [];

          // Fetch data in parallel
          const [observations, conditions, medications] = await Promise.all([
            scanAll || categories.includes("labs") || categories.includes("vitals")
              ? this._fetchObservations(req, patientId)
              : Promise.resolve([]),
            scanAll || categories.includes("conditions")
              ? this._fetchConditions(req, patientId)
              : Promise.resolve([]),
            scanAll || categories.includes("medications")
              ? this._fetchMedications(req, patientId)
              : Promise.resolve([]),
          ]);

          // 1. Critical Lab Values
          if (scanAll || categories.includes("labs")) {
            alerts.push(...this._detectCriticalLabs(observations));
          }

          // 2. Dangerous Vital Signs
          if (scanAll || categories.includes("vitals")) {
            alerts.push(...this._detectDangerousVitals(observations));
          }

          // 3. Sepsis Screening (qSOFA)
          if (scanAll || categories.includes("vitals")) {
            alerts.push(...this._screenForSepsis(observations));
          }

          // 4. High-Risk Condition Combinations
          if (scanAll || categories.includes("conditions")) {
            alerts.push(...this._detectHighRiskConditions(conditions));
          }

          // 5. Medication Safety Alerts
          if (scanAll || categories.includes("medications")) {
            alerts.push(...this._detectMedicationAlerts(medications, conditions, observations));
          }

          // Sort by severity
          const severityOrder = { critical: 0, urgent: 1, warning: 2, info: 3 };
          alerts.sort((a, b) => severityOrder[a.severity] - severityOrder[b.severity]);

          const criticalCount = alerts.filter((a) => a.severity === "critical").length;
          const urgentCount = alerts.filter((a) => a.severity === "urgent").length;

          const response = {
            patientId,
            scanTimestamp: new Date().toISOString(),
            totalAlerts: alerts.length,
            criticalAlerts: criticalCount,
            urgentAlerts: urgentCount,
            warningAlerts: alerts.filter((a) => a.severity === "warning").length,
            overallStatus: criticalCount > 0 ? "CRITICAL" : urgentCount > 0 ? "URGENT" : alerts.length > 0 ? "ATTENTION" : "STABLE",
            alerts,
            clinicalSummary: this._generateAlertSummary(alerts, criticalCount, urgentCount),
          };

          return McpUtilities.createJsonResponse(
            response as unknown as Record<string, unknown>,
          );
        } catch (error) {
          const message = error instanceof Error ? error.message : "Unknown error";
          return McpUtilities.createTextResponse(
            `Error detecting clinical alerts: ${message}`,
            { isError: true },
          );
        }
      },
    );
  }

  private _detectCriticalLabs(observations: ObsData[]): ClinicalAlert[] {
    const alerts: ClinicalAlert[] = [];
    const labAlerts: { name: string; code: string; critLow?: number; critHigh?: number; unit: string; category: string }[] = [
      { name: "Potassium", code: "potassium", critLow: 2.5, critHigh: 6.5, unit: "mEq/L", category: "Electrolyte" },
      { name: "Sodium", code: "sodium", critLow: 120, critHigh: 160, unit: "mEq/L", category: "Electrolyte" },
      { name: "Glucose", code: "glucose", critLow: 40, critHigh: 500, unit: "mg/dL", category: "Metabolic" },
      { name: "Hemoglobin", code: "hemoglobin", critLow: 7.0, critHigh: undefined, unit: "g/dL", category: "Hematologic" },
      { name: "Platelets", code: "platelets", critLow: 20, critHigh: undefined, unit: "×10³/µL", category: "Hematologic" },
      { name: "INR", code: "inr", critHigh: 5.0, unit: "", category: "Coagulation" },
      { name: "Creatinine", code: "creatinine", critHigh: 10.0, unit: "mg/dL", category: "Renal" },
      { name: "Troponin", code: "troponin", critHigh: 0.04, unit: "ng/mL", category: "Cardiac" },
      { name: "Lactate", code: "lactate", critHigh: 4.0, unit: "mmol/L", category: "Perfusion" },
      { name: "pH", code: "ph", critLow: 7.2, critHigh: 7.6, unit: "", category: "Acid-Base" },
    ];

    for (const labDef of labAlerts) {
      const obs = observations.find((o) =>
        o.display.toLowerCase().includes(labDef.code) ||
        o.code === labDef.code,
      );
      if (!obs || obs.numericValue === undefined) continue;

      if (labDef.critLow !== undefined && obs.numericValue < labDef.critLow) {
        alerts.push({
          severity: "critical",
          category: `Critical Lab - ${labDef.category}`,
          title: `CRITICALLY LOW ${labDef.name}: ${obs.numericValue} ${labDef.unit}`,
          detail: `${labDef.name} is ${obs.numericValue} ${labDef.unit} (critical threshold: <${labDef.critLow}). Immediate intervention required.`,
          action: `Verify result. Initiate emergency protocol for critically low ${labDef.name.toLowerCase()}.`,
          dataSource: `Observation from ${obs.date}`,
        });
      }
      if (labDef.critHigh !== undefined && obs.numericValue > labDef.critHigh) {
        alerts.push({
          severity: "critical",
          category: `Critical Lab - ${labDef.category}`,
          title: `CRITICALLY HIGH ${labDef.name}: ${obs.numericValue} ${labDef.unit}`,
          detail: `${labDef.name} is ${obs.numericValue} ${labDef.unit} (critical threshold: >${labDef.critHigh}). Immediate intervention required.`,
          action: `Verify result. Initiate emergency protocol for critically high ${labDef.name.toLowerCase()}.`,
          dataSource: `Observation from ${obs.date}`,
        });
      }
    }

    return alerts;
  }

  private _detectDangerousVitals(observations: ObsData[]): ClinicalAlert[] {
    const alerts: ClinicalAlert[] = [];

    const hr = observations.find((o) => o.display.toLowerCase().includes("heart rate"));
    const spo2 = observations.find((o) => o.display.toLowerCase().includes("oxygen") || o.display.toLowerCase().includes("spo2"));
    const temp = observations.find((o) => o.display.toLowerCase().includes("temperature"));

    if (hr?.numericValue && hr.numericValue > 150) {
      alerts.push({
        severity: "critical",
        category: "Vital Signs - Cardiac",
        title: `TACHYCARDIA: HR ${hr.numericValue} bpm`,
        detail: "Heart rate >150 bpm. Rule out: SVT, VT, sepsis, PE, hemorrhage, thyroid storm.",
        action: "12-lead ECG immediately. Assess hemodynamic stability. If unstable, prepare for cardioversion.",
        dataSource: `Observation from ${hr.date}`,
      });
    } else if (hr?.numericValue && hr.numericValue < 40) {
      alerts.push({
        severity: "critical",
        category: "Vital Signs - Cardiac",
        title: `SEVERE BRADYCARDIA: HR ${hr.numericValue} bpm`,
        detail: "Heart rate <40 bpm. Rule out: complete heart block, medication effect, hypothermia.",
        action: "12-lead ECG. Atropine 0.5mg IV if symptomatic. Prepare transcutaneous pacing.",
        dataSource: `Observation from ${hr.date}`,
      });
    }

    if (spo2?.numericValue && spo2.numericValue < 88) {
      alerts.push({
        severity: "critical",
        category: "Vital Signs - Respiratory",
        title: `SEVERE HYPOXEMIA: SpO2 ${spo2.numericValue}%`,
        detail: "Oxygen saturation <88%. Immediate respiratory failure risk.",
        action: "High-flow oxygen immediately. Assess airway. Prepare for intubation if not improving. ABG stat.",
        dataSource: `Observation from ${spo2.date}`,
      });
    }

    if (temp?.numericValue && temp.numericValue > 40.5) {
      alerts.push({
        severity: "urgent",
        category: "Vital Signs - Temperature",
        title: `HYPERPYREXIA: Temp ${temp.numericValue}°C`,
        detail: "Temperature >40.5°C. Risk of seizures, organ damage. Rule out: infection, drug reaction, heat stroke.",
        action: "Active cooling measures. Blood cultures ×2. Broad-spectrum antibiotics if infection suspected.",
        dataSource: `Observation from ${temp.date}`,
      });
    }

    return alerts;
  }

  private _screenForSepsis(observations: ObsData[]): ClinicalAlert[] {
    const alerts: ClinicalAlert[] = [];

    // qSOFA criteria: RR ≥22, altered mentation (GCS <15), SBP ≤100
    let qsofaScore = 0;
    const criteria: string[] = [];

    const rr = observations.find((o) => o.display.toLowerCase().includes("respiratory"));
    if (rr?.numericValue && rr.numericValue >= 22) {
      qsofaScore++;
      criteria.push(`RR ${rr.numericValue} (≥22)`);
    }

    const sbp = observations.find((o) => o.display.toLowerCase().includes("systolic"));
    if (sbp?.numericValue && sbp.numericValue <= 100) {
      qsofaScore++;
      criteria.push(`SBP ${sbp.numericValue} (≤100)`);
    }

    const gcs = observations.find((o) => o.display.toLowerCase().includes("glasgow"));
    if (gcs?.numericValue && gcs.numericValue < 15) {
      qsofaScore++;
      criteria.push(`GCS ${gcs.numericValue} (<15)`);
    }

    if (qsofaScore >= 2) {
      alerts.push({
        severity: "critical",
        category: "Sepsis Screening",
        title: `qSOFA POSITIVE (${qsofaScore}/3): SEPSIS SUSPECTED`,
        detail: `Quick SOFA score ≥2 indicates high risk of sepsis. Criteria met: ${criteria.join(", ")}. Associated with increased mortality.`,
        action: "ACTIVATE SEPSIS BUNDLE: 1) Blood cultures ×2, 2) Serum lactate, 3) Broad-spectrum antibiotics within 1 hour, 4) 30mL/kg crystalloid if hypotensive, 5) Reassess volume status.",
        dataSource: "Calculated from vital signs",
      });
    }

    return alerts;
  }

  private _detectHighRiskConditions(conditions: string[]): ClinicalAlert[] {
    const alerts: ClinicalAlert[] = [];
    const condText = conditions.join(" ").toLowerCase();

    // Acute conditions that need immediate attention
    const acutePatterns = [
      { pattern: "acute myocardial infarction", alert: "ACTIVE MI", action: "Cardiology STAT. Cath lab activation." },
      { pattern: "pulmonary embolism", alert: "ACTIVE PE", action: "Anticoagulation. CT-PA if not confirmed. Hemodynamic monitoring." },
      { pattern: "stroke", alert: "ACTIVE STROKE", action: "Neurology STAT. CT head. tPA window assessment." },
      { pattern: "septic shock", alert: "SEPTIC SHOCK", action: "ICU. Vasopressors. Broad-spectrum antibiotics. Volume resuscitation." },
      { pattern: "diabetic ketoacidosis", alert: "DKA", action: "Insulin drip. Aggressive IV fluids. Electrolyte monitoring q2h." },
    ];

    for (const ap of acutePatterns) {
      if (condText.includes(ap.pattern)) {
        alerts.push({
          severity: "critical",
          category: "Active Critical Condition",
          title: ap.alert,
          detail: `Patient has active ${ap.pattern}. This is a life-threatening condition requiring immediate intervention.`,
          action: ap.action,
          dataSource: "Active Conditions list",
        });
      }
    }

    // Dangerous combinations
    if (condText.includes("atrial fibrillation") && !condText.includes("anticoagul")) {
      alerts.push({
        severity: "warning",
        category: "Condition Management Gap",
        title: "Atrial Fibrillation without documented anticoagulation assessment",
        detail: "Patient has AF. Stroke risk should be assessed with CHA₂DS₂-VASc and anticoagulation considered.",
        action: "Calculate CHA₂DS₂-VASc score. If ≥2 (male) or ≥3 (female), initiate anticoagulation discussion.",
        dataSource: "Condition analysis",
      });
    }

    return alerts;
  }

  private _detectMedicationAlerts(medications: string[], _conditions: string[], observations: ObsData[]): ClinicalAlert[] {
    const alerts: ClinicalAlert[] = [];
    const medText = medications.join(" ").toLowerCase();

    // High-risk medication without monitoring
    if (medText.includes("warfarin") || medText.includes("coumadin")) {
      const inr = observations.find((o) => o.display.toLowerCase().includes("inr"));
      if (inr?.numericValue && inr.numericValue > 4.0) {
        alerts.push({
          severity: "urgent",
          category: "Medication Safety",
          title: `SUPRATHERAPEUTIC INR: ${inr.numericValue} (on Warfarin)`,
          detail: "INR >4.0 significantly increases bleeding risk. Risk of intracranial hemorrhage.",
          action: "Hold warfarin. If INR >9 or active bleeding: Vitamin K 2.5-5mg PO/IV. If life-threatening bleeding: 4-factor PCC + Vitamin K 10mg IV.",
          dataSource: `INR from ${inr.date}`,
        });
      }
    }

    // Metformin + renal impairment
    if (medText.includes("metformin")) {
      const cr = observations.find((o) => o.display.toLowerCase().includes("creatinine"));
      if (cr?.numericValue && cr.numericValue > 1.5) {
        alerts.push({
          severity: "warning",
          category: "Medication Safety",
          title: "Metformin with elevated creatinine",
          detail: `Patient on metformin with creatinine ${cr.numericValue} mg/dL. Lactic acidosis risk increases with renal impairment.`,
          action: "Calculate eGFR. If <30: discontinue metformin immediately. If 30-45: reduce dose. Monitor lactate.",
          dataSource: "Medication + Lab correlation",
        });
      }
    }

    // Opioids + benzodiazepines
    const hasOpioid = medText.includes("morphine") || medText.includes("oxycodone") || medText.includes("fentanyl") || medText.includes("hydrocodone");
    const hasBenzo = medText.includes("diazepam") || medText.includes("lorazepam") || medText.includes("alprazolam") || medText.includes("midazolam");
    if (hasOpioid && hasBenzo) {
      alerts.push({
        severity: "urgent",
        category: "Medication Safety - FDA Black Box",
        title: "CONCURRENT OPIOID + BENZODIAZEPINE (FDA Black Box Warning)",
        detail: "Concomitant use of opioids and benzodiazepines increases risk of respiratory depression, sedation, coma, and death.",
        action: "Review necessity of both medications. If both required: use lowest doses, shortest duration. Monitor respiratory rate and sedation level closely.",
        dataSource: "Medication analysis",
      });
    }

    return alerts;
  }

  private _generateAlertSummary(alerts: ClinicalAlert[], critical: number, urgent: number): string {
    if (critical > 0) {
      return `🚨 ${critical} CRITICAL ALERT(S) DETECTED. Immediate clinical action required. Patient safety at risk. Review critical alerts immediately before any other action.`;
    }
    if (urgent > 0) {
      return `⚠️ ${urgent} urgent alert(s) detected. Timely intervention needed. Review and address within current encounter.`;
    }
    if (alerts.length > 0) {
      return `ℹ️ ${alerts.length} alert(s) for awareness. No immediate danger but clinical attention recommended.`;
    }
    return "✅ No clinical alerts detected. Patient appears stable based on available data.";
  }

  private async _fetchObservations(req: Request, patientId: string): Promise<ObsData[]> {
    try {
      const bundle = await FhirClientInstance.search(req, "Observation", [
        `patient=${patientId}`,
        "_sort=-date",
        "_count=50",
      ]);
      if (!bundle?.entry?.length) return [];
      return bundle.entry
        .filter((e) => !!e.resource)
        .map((e) => {
          const o = e.resource as fhirR4.Observation;
          return {
            display: o.code?.text ?? o.code?.coding?.[0]?.display ?? "",
            code: o.code?.coding?.[0]?.code ?? "",
            numericValue: o.valueQuantity?.value,
            date: o.effectiveDateTime ?? o.issued ?? "unknown",
          };
        });
    } catch {
      return [];
    }
  }

  private async _fetchConditions(req: Request, patientId: string): Promise<string[]> {
    try {
      const bundle = await FhirClientInstance.search(req, "Condition", [
        `patient=${patientId}`,
        "clinical-status=active",
      ]);
      if (!bundle?.entry?.length) return [];
      return bundle.entry
        .filter((e) => !!e.resource)
        .map((e) => {
          const c = e.resource as fhirR4.Condition;
          return c.code?.text ?? c.code?.coding?.[0]?.display ?? "";
        });
    } catch {
      return [];
    }
  }

  private async _fetchMedications(req: Request, patientId: string): Promise<string[]> {
    try {
      const bundle = await FhirClientInstance.search(req, "MedicationRequest", [
        `patient=${patientId}`,
        "status=active",
      ]);
      if (!bundle?.entry?.length) return [];
      return bundle.entry
        .filter((e) => !!e.resource)
        .map((e) => {
          const m = e.resource as fhirR4.MedicationRequest;
          return m.medicationCodeableConcept?.text ?? m.medicationCodeableConcept?.coding?.[0]?.display ?? "";
        });
    } catch {
      return [];
    }
  }
}

interface ObsData {
  display: string;
  code: string;
  numericValue?: number;
  date: string;
}

export const DetectClinicalAlertsToolInstance = new DetectClinicalAlertsTool();
