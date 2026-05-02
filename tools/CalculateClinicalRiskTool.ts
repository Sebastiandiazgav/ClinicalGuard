import { McpServer } from "@modelcontextprotocol/sdk/server/mcp";
import { Request } from "express";
import { IMcpTool } from "../IMcpTool";
import { z } from "zod";
import { FhirClientInstance } from "../fhir-client";
import { FhirUtilities } from "../fhir-utilities";
import { McpUtilities } from "../mcp-utilities";
import { NullUtilities } from "../null-utilities";
import { calculateHasBled } from "../clinical/scores/has-bled";
import { calculateCha2ds2Vasc } from "../clinical/scores/cha2ds2-vasc";
import { calculateWellsPe } from "../clinical/scores/wells";
import { calculateMeld } from "../clinical/scores/meld";
import { calculateCkdEpi } from "../clinical/scores/ckd-epi";
import { fhirR4 } from "@smile-cdr/fhirts";
import { differenceInYears, parseISO } from "date-fns";

class CalculateClinicalRiskTool implements IMcpTool {
  registerTool(server: McpServer, req: Request) {
    server.registerTool(
      "CalculateClinicalRisk",
      {
        description:
          "Calculates validated clinical risk scores for a patient by extracting data from FHIR. " +
          "Supports: HAS-BLED (bleeding risk), CHA2DS2-VASc (stroke risk in atrial fibrillation), " +
          "Wells Score (pulmonary embolism probability), MELD (liver disease severity), " +
          "and CKD-EPI (kidney function/eGFR). " +
          "Automatically retrieves labs, conditions, and demographics from the patient record.",
        inputSchema: {
          scoreType: z
            .enum(["HAS-BLED", "CHA2DS2-VASc", "Wells-PE", "MELD", "CKD-EPI", "ALL"])
            .describe(
              "Which clinical score to calculate. Use 'ALL' to calculate all applicable scores.",
            ),
          patientId: z
            .string()
            .describe("The patient ID. Optional if FHIR context exists.")
            .optional(),
          clinicalInputs: z
            .object({
              clinicalSignsDvt: z.boolean().optional(),
              peIsTopDiagnosis: z.boolean().optional(),
              heartRateOver100: z.boolean().optional(),
              immobilizationOrSurgery: z.boolean().optional(),
              hemoptysis: z.boolean().optional(),
              labileInr: z.boolean().optional(),
              bleedingHistory: z.boolean().optional(),
            })
            .describe(
              "Optional clinical inputs that cannot be extracted from FHIR (e.g., physical exam findings). " +
              "Only needed for Wells PE and HAS-BLED scores.",
            )
            .optional(),
        },
      },
      async ({ scoreType, patientId, clinicalInputs }) => {
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

          // Fetch conditions
          const conditions = await this._getConditions(req, patientId);
          const conditionNames = conditions.map((c) => c.toLowerCase());

          // Fetch observations (labs)
          const labs = await this._getRecentLabs(req, patientId);

          const results: Record<string, unknown> = {
            patientId,
            patientName: this._getPatientName(patient),
            age,
            gender: patient.gender,
            calculatedAt: new Date().toISOString(),
            scores: {},
          };

          // Calculate requested scores
          if (scoreType === "CKD-EPI" || scoreType === "ALL") {
            const creatinine = labs["creatinine"];
            if (creatinine && age) {
              const ckdResult = calculateCkdEpi({ creatinine, age, isFemale });
              (results["scores"] as Record<string, unknown>)["CKD-EPI"] = ckdResult;
            } else {
              (results["scores"] as Record<string, unknown>)["CKD-EPI"] = {
                error: "Missing data: serum creatinine or age not available.",
              };
            }
          }

          if (scoreType === "CHA2DS2-VASc" || scoreType === "ALL") {
            if (age) {
              const cha2Result = calculateCha2ds2Vasc({
                congestiveHeartFailure: this._hasCondition(conditionNames, ["heart failure", "chf", "cardiomyopathy"]),
                hypertension: this._hasCondition(conditionNames, ["hypertension", "high blood pressure", "htn"]),
                age,
                diabetesMellitus: this._hasCondition(conditionNames, ["diabetes", "dm", "type 2", "type 1"]),
                strokeTiaHistory: this._hasCondition(conditionNames, ["stroke", "tia", "cerebrovascular", "cva"]),
                vascularDisease: this._hasCondition(conditionNames, ["myocardial infarction", "mi", "peripheral arterial", "pad", "aortic"]),
                isFemale,
              });
              (results["scores"] as Record<string, unknown>)["CHA2DS2-VASc"] = cha2Result;
            }
          }

          if (scoreType === "HAS-BLED" || scoreType === "ALL") {
            if (age) {
              const hasbledResult = calculateHasBled({
                hypertension: this._hasCondition(conditionNames, ["hypertension", "htn"]),
                abnormalRenalFunction: this._hasCondition(conditionNames, ["renal", "kidney", "ckd", "dialysis"]),
                abnormalLiverFunction: this._hasCondition(conditionNames, ["liver", "hepat", "cirrhosis"]),
                strokeHistory: this._hasCondition(conditionNames, ["stroke", "cva"]),
                bleedingHistory: clinicalInputs?.bleedingHistory ?? this._hasCondition(conditionNames, ["bleeding", "hemorrhage"]),
                labileInr: clinicalInputs?.labileInr ?? false,
                elderly: age > 65,
                drugsAntiplatelet: false, // Would need medication check
                alcoholUse: this._hasCondition(conditionNames, ["alcohol"]),
              });
              (results["scores"] as Record<string, unknown>)["HAS-BLED"] = hasbledResult;
            }
          }

          if (scoreType === "Wells-PE" || scoreType === "ALL") {
            const wellsResult = calculateWellsPe({
              clinicalSignsDvt: clinicalInputs?.clinicalSignsDvt ?? false,
              peIsTopDiagnosis: clinicalInputs?.peIsTopDiagnosis ?? false,
              heartRateOver100: clinicalInputs?.heartRateOver100 ?? (labs["heartRate"] ? labs["heartRate"] > 100 : false),
              immobilizationOrSurgery: clinicalInputs?.immobilizationOrSurgery ?? false,
              previousPeDvt: this._hasCondition(conditionNames, ["pulmonary embolism", "deep vein", "dvt", "pe"]),
              hemoptysis: clinicalInputs?.hemoptysis ?? false,
              malignancy: this._hasCondition(conditionNames, ["cancer", "malignant", "neoplasm", "carcinoma", "lymphoma", "leukemia"]),
            });
            (results["scores"] as Record<string, unknown>)["Wells-PE"] = wellsResult;
          }

          if (scoreType === "MELD" || scoreType === "ALL") {
            const creatinine = labs["creatinine"];
            const bilirubin = labs["bilirubin"];
            const inr = labs["inr"];
            if (creatinine && bilirubin && inr) {
              const meldResult = calculateMeld({
                creatinine,
                bilirubin,
                inr,
                sodium: labs["sodium"],
                isOnDialysis: this._hasCondition(conditionNames, ["dialysis"]),
              });
              (results["scores"] as Record<string, unknown>)["MELD"] = meldResult;
            } else {
              (results["scores"] as Record<string, unknown>)["MELD"] = {
                error: "Missing data: creatinine, bilirubin, or INR not available.",
                available: { creatinine: !!creatinine, bilirubin: !!bilirubin, inr: !!inr },
              };
            }
          }

          return McpUtilities.createJsonResponse(results);
        } catch (error) {
          const message = error instanceof Error ? error.message : "Unknown error";
          return McpUtilities.createTextResponse(
            `Error calculating clinical risk: ${message}`,
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

  private async _getConditions(req: Request, patientId: string): Promise<string[]> {
    try {
      const bundle = await FhirClientInstance.search(req, "Condition", [
        `patient=${patientId}`,
        "clinical-status=active",
      ]);
      if (!bundle?.entry?.length) return [];
      return bundle.entry
        .filter((e) => !!e.resource)
        .map((e) => {
          const cond = e.resource as fhirR4.Condition;
          return cond.code?.text ?? cond.code?.coding?.[0]?.display ?? "";
        })
        .filter((c) => c.length > 0);
    } catch {
      return [];
    }
  }

  private async _getRecentLabs(
    req: Request,
    patientId: string,
  ): Promise<Record<string, number>> {
    const labs: Record<string, number> = {};
    const labCodes: Record<string, string[]> = {
      creatinine: ["2160-0", "creatinine"],
      bilirubin: ["1975-2", "bilirubin"],
      inr: ["6301-6", "34714-6", "inr"],
      sodium: ["2951-2", "sodium"],
      potassium: ["2823-3", "potassium"],
      hemoglobin: ["718-7", "hemoglobin"],
      platelets: ["777-3", "platelets"],
      heartRate: ["8867-4", "heart rate"],
    };

    try {
      const bundle = await FhirClientInstance.search(req, "Observation", [
        `patient=${patientId}`,
        "category=laboratory,vital-signs",
        "_sort=-date",
        "_count=50",
      ]);

      if (!bundle?.entry?.length) return labs;

      for (const entry of bundle.entry) {
        if (!entry.resource) continue;
        const obs = entry.resource as fhirR4.Observation;
        const obsCode = obs.code?.coding?.[0]?.code ?? "";
        const obsDisplay = (obs.code?.text ?? obs.code?.coding?.[0]?.display ?? "").toLowerCase();

        for (const [labName, codes] of Object.entries(labCodes)) {
          if (labs[labName] !== undefined) continue; // Already have most recent
          const match = codes.some(
            (c) => c === obsCode || obsDisplay.includes(c),
          );
          if (match && obs.valueQuantity?.value !== undefined) {
            labs[labName] = obs.valueQuantity.value;
          }
        }
      }
    } catch {
      // Return whatever we have
    }

    return labs;
  }

  private _hasCondition(conditionNames: string[], keywords: string[]): boolean {
    return conditionNames.some((c) =>
      keywords.some((k) => c.includes(k)),
    );
  }
}

export const CalculateClinicalRiskToolInstance = new CalculateClinicalRiskTool();
