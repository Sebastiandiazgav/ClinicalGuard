import { McpServer } from "@modelcontextprotocol/sdk/server/mcp";
import { Request } from "express";
import { IMcpTool } from "../IMcpTool";
import { z } from "zod";
import { FhirClientInstance } from "../fhir-client";
import { FhirUtilities } from "../fhir-utilities";
import { McpUtilities } from "../mcp-utilities";
import { NullUtilities } from "../null-utilities";
import { checkDrugInteractions } from "../clinical/interactions/drug-database";
import { fhirR4 } from "@smile-cdr/fhirts";

class ValidateDrugInteractionsTool implements IMcpTool {
  registerTool(server: McpServer, req: Request) {
    server.registerTool(
      "ValidateDrugInteractions",
      {
        description:
          "Validates drug-drug and drug-condition interactions for a patient. " +
          "Retrieves the patient's current medications, allergies, and conditions from FHIR, " +
          "then cross-references proposed new medications against the existing regimen. " +
          "Returns severity-ranked interactions with clinical evidence and therapeutic alternatives. " +
          "Use this tool BEFORE prescribing any new medication.",
        inputSchema: {
          proposedMedications: z
            .array(z.string())
            .describe(
              "List of medication names being considered for prescription (generic or brand names)",
            ),
          patientId: z
            .string()
            .describe("The patient ID. Optional if FHIR context exists.")
            .optional(),
        },
      },
      async ({ proposedMedications, patientId }) => {
        try {
          // Resolve patient ID from SHARP context or parameter
          if (!patientId) {
            patientId = NullUtilities.getOrThrow(
              FhirUtilities.getPatientIdIfContextExists(req),
              "Patient ID is required. Provide it as a parameter or ensure FHIR context is available.",
            );
          }

          // 1. Fetch current medications from FHIR
          const currentMeds = await this._getCurrentMedications(req, patientId);

          // 2. Fetch allergies from FHIR
          const allergies = await this._getAllergies(req, patientId);

          // 3. Fetch active conditions from FHIR
          const conditions = await this._getActiveConditions(req, patientId);

          // 4. Build condition flags for drug-condition interactions
          const conditionFlags = this._mapConditionsToFlags(conditions);

          // 5. Combine current + proposed medications
          const allMedications = [...currentMeds, ...proposedMedications];

          // 6. Check interactions
          const result = checkDrugInteractions(allMedications, conditionFlags);

          // 7. Check allergies against proposed medications
          const allergyWarnings = this._checkAllergies(
            proposedMedications,
            allergies,
          );

          // 8. Build response
          const response = {
            patientId,
            currentMedications: currentMeds,
            proposedMedications,
            allergies: allergies.map((a) => a.display),
            activeConditions: conditions.map((c) => c.display),
            interactionAnalysis: {
              overallRiskLevel: result.overallRiskLevel,
              summary: result.summary,
              totalInteractions: result.totalInteractions,
              criticalCount: result.criticalCount,
              severeCount: result.severeCount,
              moderateCount: result.moderateCount,
              interactions: result.interactions.map((i) => ({
                drug1: i.drug1,
                drug2: i.drug2,
                severity: i.severity,
                mechanism: i.mechanism,
                clinicalEffect: i.clinicalEffect,
                recommendation: i.recommendation,
                alternatives: i.alternatives,
                evidenceLevel: i.evidenceLevel,
              })),
            },
            allergyWarnings,
            clinicalRecommendation: this._generateRecommendation(
              result,
              allergyWarnings,
            ),
          };

          return McpUtilities.createJsonResponse(
            response as unknown as Record<string, unknown>,
          );
        } catch (error) {
          const message =
            error instanceof Error ? error.message : "Unknown error";
          return McpUtilities.createTextResponse(
            `Error validating drug interactions: ${message}`,
            { isError: true },
          );
        }
      },
    );
  }

  private async _getCurrentMedications(
    req: Request,
    patientId: string,
  ): Promise<string[]> {
    try {
      const bundle = await FhirClientInstance.search(req, "MedicationRequest", [
        `patient=${patientId}`,
        "status=active",
      ]);

      if (!bundle?.entry?.length) {
        // Try MedicationStatement as fallback
        const stmtBundle = await FhirClientInstance.search(
          req,
          "MedicationStatement",
          [`patient=${patientId}`, "status=active"],
        );

        if (!stmtBundle?.entry?.length) return [];

        return stmtBundle.entry
          .filter((e) => !!e.resource)
          .map((e) => {
            const stmt = e.resource as fhirR4.MedicationStatement;
            return (
              stmt.medicationCodeableConcept?.text ??
              stmt.medicationCodeableConcept?.coding?.[0]?.display ??
              "Unknown medication"
            );
          });
      }

      return bundle.entry
        .filter((e) => !!e.resource)
        .map((e) => {
          const medReq = e.resource as fhirR4.MedicationRequest;
          return (
            medReq.medicationCodeableConcept?.text ??
            medReq.medicationCodeableConcept?.coding?.[0]?.display ??
            "Unknown medication"
          );
        });
    } catch {
      return [];
    }
  }

  private async _getAllergies(
    req: Request,
    patientId: string,
  ): Promise<{ display: string; substance: string }[]> {
    try {
      const bundle = await FhirClientInstance.search(
        req,
        "AllergyIntolerance",
        [`patient=${patientId}`, "clinical-status=active"],
      );

      if (!bundle?.entry?.length) return [];

      return bundle.entry
        .filter((e) => !!e.resource)
        .map((e) => {
          const allergy = e.resource as fhirR4.AllergyIntolerance;
          const display =
            allergy.code?.text ??
            allergy.code?.coding?.[0]?.display ??
            "Unknown allergen";
          return { display, substance: display.toLowerCase() };
        });
    } catch {
      return [];
    }
  }

  private async _getActiveConditions(
    req: Request,
    patientId: string,
  ): Promise<{ display: string; code: string }[]> {
    try {
      const bundle = await FhirClientInstance.search(req, "Condition", [
        `patient=${patientId}`,
        "clinical-status=active",
      ]);

      if (!bundle?.entry?.length) return [];

      return bundle.entry
        .filter((e) => !!e.resource)
        .map((e) => {
          const condition = e.resource as fhirR4.Condition;
          return {
            display:
              condition.code?.text ??
              condition.code?.coding?.[0]?.display ??
              "Unknown condition",
            code: condition.code?.coding?.[0]?.code ?? "",
          };
        });
    } catch {
      return [];
    }
  }

  private _mapConditionsToFlags(
    conditions: { display: string; code: string }[],
  ): string[] {
    const flags: string[] = [];
    const conditionText = conditions
      .map((c) => c.display.toLowerCase())
      .join(" ");

    if (
      conditionText.includes("renal") ||
      conditionText.includes("kidney") ||
      conditionText.includes("ckd") ||
      conditionText.includes("nephro")
    ) {
      flags.push("renal_impairment");
    }

    if (
      conditionText.includes("liver") ||
      conditionText.includes("hepat") ||
      conditionText.includes("cirrhosis")
    ) {
      flags.push("liver_impairment");
    }

    return flags;
  }

  private _checkAllergies(
    proposedMedications: string[],
    allergies: { display: string; substance: string }[],
  ): string[] {
    const warnings: string[] = [];

    for (const med of proposedMedications) {
      const medLower = med.toLowerCase();
      for (const allergy of allergies) {
        if (
          allergy.substance.includes(medLower) ||
          medLower.includes(allergy.substance)
        ) {
          warnings.push(
            `ALLERGY ALERT: Patient has documented allergy to "${allergy.display}". Proposed medication "${med}" may be contraindicated.`,
          );
        }
      }
    }

    return warnings;
  }

  private _generateRecommendation(
    result: ReturnType<typeof checkDrugInteractions>,
    allergyWarnings: string[],
  ): string {
    const parts: string[] = [];

    if (allergyWarnings.length > 0) {
      parts.push(
        "⚠️ ALLERGY CONCERNS: " + allergyWarnings.join(" "),
      );
    }

    if (result.criticalCount > 0) {
      parts.push(
        "🚫 CONTRAINDICATED COMBINATIONS DETECTED. Do NOT proceed with current medication plan. Review alternatives immediately.",
      );
    } else if (result.severeCount > 0) {
      parts.push(
        "⚠️ SEVERE INTERACTIONS DETECTED. Proceed with extreme caution. Consider dose adjustments or alternative medications.",
      );
    } else if (result.moderateCount > 0) {
      parts.push(
        "ℹ️ MODERATE INTERACTIONS DETECTED. Monitor patient closely. Adjust therapy if clinically indicated.",
      );
    } else {
      parts.push(
        "✅ No significant drug interactions detected. Proceed with standard prescribing precautions.",
      );
    }

    return parts.join("\n\n");
  }
}

export const ValidateDrugInteractionsToolInstance =
  new ValidateDrugInteractionsTool();
