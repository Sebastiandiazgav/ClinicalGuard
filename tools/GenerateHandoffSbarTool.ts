import { McpServer } from "@modelcontextprotocol/sdk/server/mcp";
import { Request } from "express";
import { IMcpTool } from "../IMcpTool";
import { z } from "zod";
import { FhirClientInstance } from "../fhir-client";
import { FhirUtilities } from "../fhir-utilities";
import { McpUtilities } from "../mcp-utilities";
import { NullUtilities } from "../null-utilities";
import { fhirR4 } from "@smile-cdr/fhirts";
import { differenceInYears, parseISO } from "date-fns";

class GenerateHandoffSbarTool implements IMcpTool {
  registerTool(server: McpServer, req: Request) {
    server.registerTool(
      "GenerateHandoffSBAR",
      {
        description:
          "Generates a structured SBAR (Situation-Background-Assessment-Recommendation) " +
          "clinical handoff communication for a patient. SBAR is the gold standard for " +
          "clinical communication between healthcare providers during shift changes, " +
          "transfers, and escalations. " +
          "Automatically pulls patient data from FHIR and structures it into the SBAR format " +
          "that clinicians are trained to use. " +
          "Use this when transferring care, escalating to a specialist, or at shift change.",
        inputSchema: {
          patientId: z
            .string()
            .describe("The patient ID. Optional if FHIR context exists.")
            .optional(),
          handoffContext: z
            .enum(["shift_change", "escalation", "transfer", "specialist_consult"])
            .describe("The context for this handoff communication")
            .optional(),
          currentConcern: z
            .string()
            .describe("The primary clinical concern prompting this handoff (e.g., 'worsening respiratory status', 'new chest pain')")
            .optional(),
        },
      },
      async ({ patientId, handoffContext, currentConcern }) => {
        try {
          if (!patientId) {
            patientId = NullUtilities.getOrThrow(
              FhirUtilities.getPatientIdIfContextExists(req),
              "Patient ID is required.",
            );
          }

          const context = handoffContext ?? "shift_change";

          // Fetch all patient data
          const [patient, conditions, medications, allergies, observations] =
            await Promise.all([
              FhirClientInstance.read<fhirR4.Patient>(req, `Patient/${patientId}`),
              this._fetchConditions(req, patientId),
              this._fetchMedications(req, patientId),
              this._fetchAllergies(req, patientId),
              this._fetchRecentObservations(req, patientId),
            ]);

          if (!patient) {
            return McpUtilities.createTextResponse("Patient not found.", { isError: true });
          }

          const age = patient.birthDate
            ? differenceInYears(new Date(), parseISO(patient.birthDate))
            : null;
          const name = this._getPatientName(patient);

          // Build SBAR
          const sbar = {
            generatedAt: new Date().toISOString(),
            handoffType: context,
            patientIdentifier: `${name}, ${age}yo ${patient.gender ?? ""}`,

            situation: this._buildSituation(name, age, patient.gender, conditions, currentConcern, context),
            background: this._buildBackground(conditions, medications, allergies, observations),
            assessment: this._buildAssessment(observations, conditions, currentConcern),
            recommendation: this._buildRecommendation(context, currentConcern, observations),

            criticalInfo: {
              allergies: allergies.map((a) => a.substance),
              codeStatus: "Full Code (verify with patient chart)",
              isolationPrecautions: "Standard (verify with nursing)",
            },

            pendingItems: this._identifyPendingItems(observations, conditions),
          };

          return McpUtilities.createJsonResponse(
            sbar as unknown as Record<string, unknown>,
          );
        } catch (error) {
          const message = error instanceof Error ? error.message : "Unknown error";
          return McpUtilities.createTextResponse(
            `Error generating SBAR handoff: ${message}`,
            { isError: true },
          );
        }
      },
    );
  }

  private _buildSituation(
    name: string,
    age: number | null,
    gender: string | undefined,
    conditions: { display: string }[],
    concern: string | undefined,
    context: string,
  ): string {
    const parts: string[] = [];

    parts.push(`Patient: ${name}, ${age ?? "unknown"} year-old ${gender ?? "patient"}.`);

    if (conditions.length > 0) {
      parts.push(`Admitted with: ${conditions.slice(0, 3).map((c) => c.display).join(", ")}.`);
    }

    if (concern) {
      parts.push(`Current concern: ${concern}.`);
    }

    const contextMap: Record<string, string> = {
      shift_change: "End-of-shift handoff.",
      escalation: "Escalating due to clinical deterioration.",
      transfer: "Patient being transferred to another unit/facility.",
      specialist_consult: "Requesting specialist consultation.",
    };
    parts.push(contextMap[context] ?? "");

    return parts.join(" ");
  }

  private _buildBackground(
    conditions: { display: string }[],
    medications: { name: string; dosage: string }[],
    allergies: { substance: string; severity: string }[],
    observations: ObsEntry[],
  ): {
    medicalHistory: string[];
    currentMedications: string[];
    allergies: string[];
    recentVitals: string[];
    recentLabs: string[];
  } {
    return {
      medicalHistory: conditions.map((c) => c.display),
      currentMedications: medications.map((m) => `${m.name} (${m.dosage})`),
      allergies: allergies.map((a) => `${a.substance} (${a.severity})`),
      recentVitals: observations
        .filter((o) => o.category === "vital-signs")
        .slice(0, 6)
        .map((o) => `${o.display}: ${o.value} ${o.unit}`),
      recentLabs: observations
        .filter((o) => o.category === "laboratory")
        .slice(0, 8)
        .map((o) => `${o.display}: ${o.value} ${o.unit}${o.flag !== "normal" ? ` [${o.flag}]` : ""}`),
    };
  }

  private _buildAssessment(
    observations: ObsEntry[],
    conditions: { display: string }[],
    concern: string | undefined,
  ): string {
    const parts: string[] = [];

    // Assess stability
    const abnormalVitals = observations.filter(
      (o) => o.category === "vital-signs" && o.flag !== "normal",
    );
    const abnormalLabs = observations.filter(
      (o) => o.category === "laboratory" && o.flag !== "normal",
    );

    if (abnormalVitals.length === 0 && abnormalLabs.length === 0) {
      parts.push("Patient appears hemodynamically stable with no critical abnormalities.");
    } else {
      if (abnormalVitals.length > 0) {
        parts.push(`Abnormal vitals: ${abnormalVitals.map((v) => `${v.display} ${v.value}`).join(", ")}.`);
      }
      if (abnormalLabs.length > 0) {
        parts.push(`Abnormal labs: ${abnormalLabs.map((l) => `${l.display} ${l.value} [${l.flag}]`).join(", ")}.`);
      }
    }

    if (concern) {
      parts.push(`Primary concern: ${concern}. Requires ongoing monitoring and intervention.`);
    }

    if (conditions.length > 3) {
      parts.push("Complex patient with multiple comorbidities — higher risk for complications.");
    }

    return parts.join(" ");
  }

  private _buildRecommendation(
    context: string,
    concern: string | undefined,
    observations: ObsEntry[],
  ): string[] {
    const recs: string[] = [];

    // Context-specific recommendations
    if (context === "escalation") {
      recs.push("Urgent clinician review requested");
      recs.push("Consider increasing monitoring frequency");
      if (concern) recs.push(`Address: ${concern}`);
    } else if (context === "transfer") {
      recs.push("Ensure all pending results are followed up at receiving facility");
      recs.push("Verify medication reconciliation completed");
      recs.push("Confirm transport monitoring plan");
    } else if (context === "specialist_consult") {
      recs.push("Specialist input needed for management optimization");
      if (concern) recs.push(`Specific question: ${concern}`);
    } else {
      recs.push("Continue current management plan");
    }

    // Monitoring recommendations based on abnormals
    const abnormals = observations.filter((o) => o.flag !== "normal");
    if (abnormals.length > 0) {
      recs.push(`Monitor: ${abnormals.slice(0, 3).map((a) => a.display).join(", ")}`);
    }

    recs.push("Reassess if any clinical change");

    return recs;
  }

  private _identifyPendingItems(
    observations: ObsEntry[],
    conditions: { display: string }[],
  ): string[] {
    const pending: string[] = [];

    // Check for conditions that typically need follow-up
    const condText = conditions.map((c) => c.display.toLowerCase()).join(" ");

    if (condText.includes("infection") || condText.includes("pneumonia") || condText.includes("sepsis")) {
      pending.push("Follow up blood culture results");
      pending.push("Reassess antibiotic therapy at 48-72 hours");
    }

    if (condText.includes("kidney") || condText.includes("renal")) {
      pending.push("Repeat renal function panel");
    }

    if (observations.some((o) => o.display.toLowerCase().includes("troponin"))) {
      pending.push("Serial troponin results (if trending)");
    }

    if (pending.length === 0) {
      pending.push("No specific pending items identified — verify with clinical team");
    }

    return pending;
  }

  private _getPatientName(patient: fhirR4.Patient): string {
    const name = patient.name?.[0];
    if (!name) return "Unknown";
    return `${name.given?.join(" ") ?? ""} ${name.family ?? ""}`.trim() || "Unknown";
  }

  private async _fetchConditions(req: Request, patientId: string): Promise<{ display: string }[]> {
    try {
      const bundle = await FhirClientInstance.search(req, "Condition", [`patient=${patientId}`, "clinical-status=active"]);
      if (!bundle?.entry?.length) return [];
      return bundle.entry.filter((e) => !!e.resource).map((e) => {
        const c = e.resource as fhirR4.Condition;
        return { display: c.code?.text ?? c.code?.coding?.[0]?.display ?? "Unknown" };
      });
    } catch { return []; }
  }

  private async _fetchMedications(req: Request, patientId: string): Promise<{ name: string; dosage: string }[]> {
    try {
      const bundle = await FhirClientInstance.search(req, "MedicationRequest", [`patient=${patientId}`, "status=active"]);
      if (!bundle?.entry?.length) return [];
      return bundle.entry.filter((e) => !!e.resource).map((e) => {
        const m = e.resource as fhirR4.MedicationRequest;
        return {
          name: m.medicationCodeableConcept?.text ?? m.medicationCodeableConcept?.coding?.[0]?.display ?? "Unknown",
          dosage: m.dosageInstruction?.[0]?.text ?? "Not specified",
        };
      });
    } catch { return []; }
  }

  private async _fetchAllergies(req: Request, patientId: string): Promise<{ substance: string; severity: string }[]> {
    try {
      const bundle = await FhirClientInstance.search(req, "AllergyIntolerance", [`patient=${patientId}`]);
      if (!bundle?.entry?.length) return [];
      return bundle.entry.filter((e) => !!e.resource).map((e) => {
        const a = e.resource as fhirR4.AllergyIntolerance;
        return {
          substance: a.code?.text ?? a.code?.coding?.[0]?.display ?? "Unknown",
          severity: a.reaction?.[0]?.severity ?? "unknown",
        };
      });
    } catch { return []; }
  }

  private async _fetchRecentObservations(req: Request, patientId: string): Promise<ObsEntry[]> {
    try {
      const bundle = await FhirClientInstance.search(req, "Observation", [`patient=${patientId}`, "_sort=-date", "_count=30"]);
      if (!bundle?.entry?.length) return [];
      return bundle.entry.filter((e) => !!e.resource).map((e) => {
        const o = e.resource as fhirR4.Observation;
        return {
          display: o.code?.text ?? o.code?.coding?.[0]?.display ?? "Unknown",
          value: o.valueQuantity?.value?.toString() ?? o.valueString ?? "N/A",
          unit: o.valueQuantity?.unit ?? "",
          category: o.category?.[0]?.coding?.[0]?.code ?? "unknown",
          flag: o.interpretation?.[0]?.coding?.[0]?.code ?? "normal",
          date: o.effectiveDateTime ?? "unknown",
        };
      });
    } catch { return []; }
  }
}

interface ObsEntry {
  display: string;
  value: string;
  unit: string;
  category: string;
  flag: string;
  date: string;
}

export const GenerateHandoffSbarToolInstance = new GenerateHandoffSbarTool();
