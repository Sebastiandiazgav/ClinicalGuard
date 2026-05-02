import { McpServer } from "@modelcontextprotocol/sdk/server/mcp";
import { Request } from "express";
import { IMcpTool } from "../IMcpTool";
import { z } from "zod";
import { FhirClientInstance } from "../fhir-client";
import { FhirUtilities } from "../fhir-utilities";
import { McpUtilities } from "../mcp-utilities";
import { NullUtilities } from "../null-utilities";
import { calculateCkdEpi } from "../clinical/scores/ckd-epi";
import { getrenalDoseAdjustments } from "../clinical/dosage/renal-adjustments";
import { fhirR4 } from "@smile-cdr/fhirts";
import { differenceInYears, parseISO } from "date-fns";

class AdjustDosageRenalTool implements IMcpTool {
  registerTool(server: McpServer, req: Request) {
    server.registerTool(
      "AdjustDosageRenal",
      {
        description:
          "Calculates renal function (eGFR via CKD-EPI 2021) from the patient's most recent labs " +
          "and provides medication dose adjustments based on kidney function. " +
          "Retrieves serum creatinine, age, and sex from FHIR automatically. " +
          "Returns adjusted doses for each medication with clinical guidance.",
        inputSchema: {
          medications: z
            .array(z.string())
            .describe("List of medications to check for renal dose adjustments"),
          patientId: z
            .string()
            .describe("The patient ID. Optional if FHIR context exists.")
            .optional(),
          creatinineOverride: z
            .number()
            .describe("Manual creatinine value (mg/dL) if not available in FHIR")
            .optional(),
        },
      },
      async ({ medications, patientId, creatinineOverride }) => {
        try {
          if (!patientId) {
            patientId = NullUtilities.getOrThrow(
              FhirUtilities.getPatientIdIfContextExists(req),
              "Patient ID is required.",
            );
          }

          // Fetch patient demographics
          const patient = await FhirClientInstance.read<fhirR4.Patient>(
            req,
            `Patient/${patientId}`,
          );
          if (!patient) {
            return McpUtilities.createTextResponse("Patient not found.", { isError: true });
          }

          const age = patient.birthDate
            ? differenceInYears(new Date(), parseISO(patient.birthDate))
            : null;
          const isFemale = patient.gender === "female";

          if (!age) {
            return McpUtilities.createTextResponse(
              "Patient birth date not available. Cannot calculate eGFR.",
              { isError: true },
            );
          }

          // Get creatinine from FHIR or override
          let creatinine = creatinineOverride;
          let creatinineSource = "manual override";
          let creatinineDate: string | null = null;

          if (!creatinine) {
            const labResult = await this._getLatestCreatinine(req, patientId);
            if (labResult) {
              creatinine = labResult.value;
              creatinineSource = "FHIR Observation";
              creatinineDate = labResult.date;
            }
          }

          if (!creatinine) {
            return McpUtilities.createTextResponse(
              "Serum creatinine not available in patient record. Provide creatinineOverride parameter or ensure lab results are in FHIR.",
              { isError: true },
            );
          }

          // Calculate eGFR
          const ckdResult = calculateCkdEpi({ creatinine, age, isFemale });

          // Get dose adjustments
          const dosingResult = getrenalDoseAdjustments(medications, ckdResult.egfr);

          const response = {
            patientId,
            patientName: this._getPatientName(patient),
            renalFunction: {
              serumCreatinine: {
                value: creatinine,
                unit: "mg/dL",
                source: creatinineSource,
                date: creatinineDate,
              },
              egfr: ckdResult.egfr,
              egfrUnit: "mL/min/1.73m²",
              ckdStage: ckdResult.ckdStage,
              ckdDescription: ckdResult.ckdDescription,
              interpretation: ckdResult.interpretation,
            },
            doseAdjustments: {
              summary: dosingResult.summary,
              hasContraindications: dosingResult.hasContraindications,
              medications: dosingResult.adjustments,
            },
            clinicalGuidance: this._generateGuidance(ckdResult, dosingResult),
          };

          return McpUtilities.createJsonResponse(
            response as unknown as Record<string, unknown>,
          );
        } catch (error) {
          const message = error instanceof Error ? error.message : "Unknown error";
          return McpUtilities.createTextResponse(
            `Error adjusting renal dosage: ${message}`,
            { isError: true },
          );
        }
      },
    );
  }

  private _getPatientName(patient: fhirR4.Patient): string {
    const name = patient.name?.[0];
    if (!name) return "Unknown";
    const given = name.given?.join(" ") ?? "";
    const family = name.family ?? "";
    return `${given} ${family}`.trim() || "Unknown";
  }

  private async _getLatestCreatinine(
    req: Request,
    patientId: string,
  ): Promise<{ value: number; date: string } | null> {
    try {
      const bundle = await FhirClientInstance.search(req, "Observation", [
        `patient=${patientId}`,
        "code=2160-0", // LOINC code for serum creatinine
        "_sort=-date",
        "_count=1",
      ]);

      if (!bundle?.entry?.[0]?.resource) {
        // Fallback: search by text
        const fallback = await FhirClientInstance.search(req, "Observation", [
          `patient=${patientId}`,
          "_sort=-date",
          "_count=20",
        ]);

        if (!fallback?.entry?.length) return null;

        for (const entry of fallback.entry) {
          const obs = entry.resource as fhirR4.Observation;
          const display = (
            obs.code?.text ??
            obs.code?.coding?.[0]?.display ??
            ""
          ).toLowerCase();
          if (
            display.includes("creatinine") &&
            obs.valueQuantity?.value !== undefined
          ) {
            return {
              value: obs.valueQuantity.value,
              date: obs.effectiveDateTime ?? obs.issued ?? "unknown",
            };
          }
        }
        return null;
      }

      const obs = bundle.entry[0].resource as fhirR4.Observation;
      if (obs.valueQuantity?.value === undefined) return null;

      return {
        value: obs.valueQuantity.value,
        date: obs.effectiveDateTime ?? obs.issued ?? "unknown",
      };
    } catch {
      return null;
    }
  }

  private _generateGuidance(
    ckdResult: ReturnType<typeof calculateCkdEpi>,
    dosingResult: ReturnType<typeof getrenalDoseAdjustments>,
  ): string {
    const parts: string[] = [];

    if (dosingResult.hasContraindications) {
      parts.push(
        "🚫 CRITICAL: One or more medications are CONTRAINDICATED at this level of renal function. " +
        "Do NOT prescribe these medications. Review alternatives listed above.",
      );
    }

    if (ckdResult.requiresDoseAdjustment) {
      parts.push(
        `⚠️ Patient has ${ckdResult.ckdDescription} kidney function (CKD Stage ${ckdResult.ckdStage}, eGFR ${ckdResult.egfr}). ` +
        "Multiple medications may require dose adjustment. Review each medication's adjusted dose carefully.",
      );
    }

    parts.push(
      "📋 Recommendations: " +
      "1) Verify creatinine is recent (within 7 days for acute settings). " +
      "2) Recheck renal function after starting new medications. " +
      "3) Avoid nephrotoxic combinations when possible. " +
      "4) Consult pharmacy for complex regimens.",
    );

    return parts.join("\n\n");
  }
}

export const AdjustDosageRenalToolInstance = new AdjustDosageRenalTool();
