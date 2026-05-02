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

class GenerateClinicalSummaryTool implements IMcpTool {
  registerTool(server: McpServer, req: Request) {
    server.registerTool(
      "GenerateClinicalSummary",
      {
        description:
          "Generates a comprehensive clinical summary for a patient by aggregating data from FHIR. " +
          "Includes demographics, active conditions, current medications, allergies, recent lab results, " +
          "and vital signs. Designed for clinical handoff between agents or presentation to clinicians. " +
          "Flags critical findings that require immediate attention.",
        inputSchema: {
          patientId: z
            .string()
            .describe("The patient ID. Optional if FHIR context exists.")
            .optional(),
          includeLabDetails: z
            .boolean()
            .describe("Whether to include detailed lab results. Defaults to true.")
            .optional(),
        },
      },
      async ({ patientId, includeLabDetails }) => {
        try {
          if (!patientId) {
            patientId = NullUtilities.getOrThrow(
              FhirUtilities.getPatientIdIfContextExists(req),
              "Patient ID is required.",
            );
          }

          const showLabs = includeLabDetails !== false;

          // Fetch all patient data in parallel
          const [patient, conditions, medications, allergies, observations] =
            await Promise.all([
              FhirClientInstance.read<fhirR4.Patient>(req, `Patient/${patientId}`),
              this._fetchConditions(req, patientId),
              this._fetchMedications(req, patientId),
              this._fetchAllergies(req, patientId),
              showLabs ? this._fetchObservations(req, patientId) : Promise.resolve([]),
            ]);

          if (!patient) {
            return McpUtilities.createTextResponse("Patient not found.", { isError: true });
          }

          // Build demographics
          const age = patient.birthDate
            ? differenceInYears(new Date(), parseISO(patient.birthDate))
            : null;

          const name = patient.name?.[0];
          const patientName = name
            ? `${name.given?.join(" ") ?? ""} ${name.family ?? ""}`.trim()
            : "Unknown";

          // Identify critical flags
          const criticalFlags = this._identifyCriticalFlags(
            conditions,
            observations,
            allergies,
          );

          const summary = {
            generatedAt: new Date().toISOString(),
            patientId,
            demographics: {
              name: patientName,
              age,
              gender: patient.gender ?? "unknown",
              birthDate: patient.birthDate ?? "unknown",
              identifier:
                patient.identifier?.[0]?.value ?? patientId,
            },
            criticalFlags:
              criticalFlags.length > 0
                ? criticalFlags
                : ["No critical flags identified"],
            activeConditions: conditions.map((c) => ({
              condition: c.display,
              onsetDate: c.onset ?? "unknown",
              status: c.status,
            })),
            currentMedications: medications.map((m) => ({
              medication: m.name,
              dosage: m.dosage,
              status: m.status,
            })),
            allergies: allergies.map((a) => ({
              allergen: a.substance,
              reaction: a.reaction,
              severity: a.severity,
            })),
            recentLabs: showLabs
              ? observations
                  .filter((o) => o.category === "laboratory")
                  .slice(0, 20)
                  .map((o) => ({
                    test: o.display,
                    value: o.value,
                    unit: o.unit,
                    date: o.date,
                    flag: o.flag,
                  }))
              : "Not included (set includeLabDetails=true)",
            recentVitals: observations
              .filter((o) => o.category === "vital-signs")
              .slice(0, 10)
              .map((o) => ({
                vital: o.display,
                value: o.value,
                unit: o.unit,
                date: o.date,
              })),
            conditionCount: conditions.length,
            medicationCount: medications.length,
            allergyCount: allergies.length,
          };

          return McpUtilities.createJsonResponse(
            summary as unknown as Record<string, unknown>,
          );
        } catch (error) {
          const message = error instanceof Error ? error.message : "Unknown error";
          return McpUtilities.createTextResponse(
            `Error generating clinical summary: ${message}`,
            { isError: true },
          );
        }
      },
    );
  }

  private async _fetchConditions(
    req: Request,
    patientId: string,
  ): Promise<{ display: string; onset: string | null; status: string }[]> {
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
          return {
            display: c.code?.text ?? c.code?.coding?.[0]?.display ?? "Unknown",
            onset: c.onsetDateTime ?? null,
            status: c.clinicalStatus?.coding?.[0]?.code ?? "active",
          };
        });
    } catch {
      return [];
    }
  }

  private async _fetchMedications(
    req: Request,
    patientId: string,
  ): Promise<{ name: string; dosage: string; status: string }[]> {
    try {
      const bundle = await FhirClientInstance.search(req, "MedicationRequest", [
        `patient=${patientId}`,
        "status=active",
      ]);

      if (!bundle?.entry?.length) {
        // Fallback to MedicationStatement
        const stmtBundle = await FhirClientInstance.search(req, "MedicationStatement", [
          `patient=${patientId}`,
          "status=active",
        ]);
        if (!stmtBundle?.entry?.length) return [];
        return stmtBundle.entry
          .filter((e) => !!e.resource)
          .map((e) => {
            const s = e.resource as fhirR4.MedicationStatement;
            return {
              name: s.medicationCodeableConcept?.text ?? s.medicationCodeableConcept?.coding?.[0]?.display ?? "Unknown",
              dosage: s.dosage?.[0]?.text ?? "Dosage not specified",
              status: s.status ?? "active",
            };
          });
      }

      return bundle.entry
        .filter((e) => !!e.resource)
        .map((e) => {
          const m = e.resource as fhirR4.MedicationRequest;
          return {
            name: m.medicationCodeableConcept?.text ?? m.medicationCodeableConcept?.coding?.[0]?.display ?? "Unknown",
            dosage: m.dosageInstruction?.[0]?.text ?? "Dosage not specified",
            status: m.status ?? "active",
          };
        });
    } catch {
      return [];
    }
  }

  private async _fetchAllergies(
    req: Request,
    patientId: string,
  ): Promise<{ substance: string; reaction: string; severity: string }[]> {
    try {
      const bundle = await FhirClientInstance.search(req, "AllergyIntolerance", [
        `patient=${patientId}`,
      ]);
      if (!bundle?.entry?.length) return [];
      return bundle.entry
        .filter((e) => !!e.resource)
        .map((e) => {
          const a = e.resource as fhirR4.AllergyIntolerance;
          return {
            substance: a.code?.text ?? a.code?.coding?.[0]?.display ?? "Unknown",
            reaction: a.reaction?.[0]?.manifestation?.[0]?.text ?? a.reaction?.[0]?.manifestation?.[0]?.coding?.[0]?.display ?? "Not specified",
            severity: a.reaction?.[0]?.severity ?? "unknown",
          };
        });
    } catch {
      return [];
    }
  }

  private async _fetchObservations(
    req: Request,
    patientId: string,
  ): Promise<
    {
      display: string;
      value: string;
      unit: string;
      date: string;
      category: string;
      flag: string;
    }[]
  > {
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
          const category =
            o.category?.[0]?.coding?.[0]?.code ?? "unknown";
          return {
            display: o.code?.text ?? o.code?.coding?.[0]?.display ?? "Unknown",
            value:
              o.valueQuantity?.value?.toString() ??
              o.valueString ??
              o.valueCodeableConcept?.text ??
              "N/A",
            unit: o.valueQuantity?.unit ?? "",
            date: o.effectiveDateTime ?? o.issued ?? "unknown",
            category,
            flag: o.interpretation?.[0]?.coding?.[0]?.code ?? "normal",
          };
        });
    } catch {
      return [];
    }
  }

  private _identifyCriticalFlags(
    conditions: { display: string }[],
    observations: { display: string; value: string; flag: string }[],
    allergies: { substance: string; severity: string }[],
  ): string[] {
    const flags: string[] = [];

    // Check for critical lab values
    for (const obs of observations) {
      if (obs.flag === "H" || obs.flag === "HH" || obs.flag === "L" || obs.flag === "LL") {
        flags.push(`⚠️ Abnormal ${obs.display}: ${obs.value} (${obs.flag === "HH" || obs.flag === "LL" ? "CRITICAL" : "abnormal"})`);
      }
    }

    // Check for severe allergies
    for (const allergy of allergies) {
      if (allergy.severity === "severe") {
        flags.push(`🚨 Severe allergy: ${allergy.substance}`);
      }
    }

    // Check for high-risk conditions
    const highRiskKeywords = ["sepsis", "acute", "emergency", "critical", "unstable"];
    for (const cond of conditions) {
      if (highRiskKeywords.some((k) => cond.display.toLowerCase().includes(k))) {
        flags.push(`🔴 High-risk condition: ${cond.display}`);
      }
    }

    return flags;
  }
}

export const GenerateClinicalSummaryToolInstance = new GenerateClinicalSummaryTool();
