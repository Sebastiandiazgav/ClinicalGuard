import { McpServer } from "@modelcontextprotocol/sdk/server/mcp";
import { Request } from "express";
import { IMcpTool } from "../IMcpTool";
import { z } from "zod";
import { FhirClientInstance } from "../fhir-client";
import { FhirUtilities } from "../fhir-utilities";
import { McpUtilities } from "../mcp-utilities";
import { NullUtilities } from "../null-utilities";
import { calculateCkdEpi } from "../clinical/scores/ckd-epi";
import { fhirR4 } from "@smile-cdr/fhirts";
import { differenceInYears, parseISO } from "date-fns";

interface TherapeuticRecommendation {
  condition: string;
  guidelineSource: string;
  recommendations: {
    priority: "first-line" | "second-line" | "adjunct" | "avoid";
    therapy: string;
    rationale: string;
    contraindications: string[];
    monitoring: string;
  }[];
  patientSpecificNotes: string[];
}

class RecommendTherapeuticPlanTool implements IMcpTool {
  registerTool(server: McpServer, req: Request) {
    server.registerTool(
      "RecommendTherapeuticPlan",
      {
        description:
          "Generates evidence-based therapeutic recommendations for a patient's conditions. " +
          "Cross-references active conditions with clinical guidelines (AHA, ACC, KDIGO, ADA, ESC) " +
          "and adjusts recommendations based on patient-specific factors (renal function, age, " +
          "comorbidities, current medications, allergies). " +
          "Provides first-line, second-line, and contraindicated therapies with rationale.",
        inputSchema: {
          targetCondition: z
            .string()
            .describe("The condition to generate therapeutic recommendations for (e.g., 'atrial fibrillation', 'hypertension', 'diabetes type 2', 'heart failure')"),
          patientId: z
            .string()
            .describe("The patient ID. Optional if FHIR context exists.")
            .optional(),
        },
      },
      async ({ targetCondition, patientId }) => {
        try {
          if (!patientId) {
            patientId = NullUtilities.getOrThrow(
              FhirUtilities.getPatientIdIfContextExists(req),
              "Patient ID is required.",
            );
          }

          // Fetch patient context
          const [patient, conditions, medications, allergies, labs] = await Promise.all([
            FhirClientInstance.read<fhirR4.Patient>(req, `Patient/${patientId}`),
            this._fetchConditions(req, patientId),
            this._fetchMedications(req, patientId),
            this._fetchAllergies(req, patientId),
            this._fetchLabs(req, patientId),
          ]);

          if (!patient) {
            return McpUtilities.createTextResponse("Patient not found.", { isError: true });
          }

          const age = patient.birthDate ? differenceInYears(new Date(), parseISO(patient.birthDate)) : null;
          const isFemale = patient.gender === "female";

          // Calculate eGFR if creatinine available
          let egfr: number | null = null;
          if (labs["creatinine"] && age) {
            const ckd = calculateCkdEpi({ creatinine: labs["creatinine"], age, isFemale });
            egfr = ckd.egfr;
          }

          // Generate recommendations based on condition
          const recommendation = this._generateRecommendation(
            targetCondition.toLowerCase(),
            { age, isFemale, egfr, conditions, medications, allergies },
          );

          const response = {
            patientId,
            targetCondition,
            patientContext: {
              age,
              gender: patient.gender,
              egfr,
              activeConditions: conditions,
              currentMedications: medications,
              allergies,
            },
            therapeuticPlan: recommendation,
            disclaimer: "These recommendations are based on clinical guidelines and patient-specific factors. " +
              "They are decision-support tools and do NOT replace clinical judgment. " +
              "Always verify with current guidelines and consider the full clinical picture.",
          };

          return McpUtilities.createJsonResponse(
            response as unknown as Record<string, unknown>,
          );
        } catch (error) {
          const message = error instanceof Error ? error.message : "Unknown error";
          return McpUtilities.createTextResponse(
            `Error generating therapeutic plan: ${message}`,
            { isError: true },
          );
        }
      },
    );
  }

  private _generateRecommendation(
    condition: string,
    context: {
      age: number | null;
      isFemale: boolean;
      egfr: number | null;
      conditions: string[];
      medications: string[];
      allergies: string[];
    },
  ): TherapeuticRecommendation {
    const condLower = condition.toLowerCase();
    const condText = context.conditions.join(" ").toLowerCase();
    const medText = context.medications.join(" ").toLowerCase();
    const allergyText = context.allergies.join(" ").toLowerCase();

    // Atrial Fibrillation
    if (condLower.includes("atrial fibrillation") || condLower.includes("afib")) {
      return this._afibRecommendations(context, condText, medText, allergyText);
    }

    // Hypertension
    if (condLower.includes("hypertension") || condLower.includes("high blood pressure")) {
      return this._hypertensionRecommendations(context, condText, medText, allergyText);
    }

    // Diabetes Type 2
    if (condLower.includes("diabetes") || condLower.includes("dm") || condLower.includes("type 2")) {
      return this._diabetesRecommendations(context, condText, medText, allergyText);
    }

    // Heart Failure
    if (condLower.includes("heart failure") || condLower.includes("chf")) {
      return this._heartFailureRecommendations(context, condText, medText, allergyText);
    }

    // CKD
    if (condLower.includes("kidney") || condLower.includes("ckd") || condLower.includes("renal")) {
      return this._ckdRecommendations(context, condText, medText);
    }

    // Generic response for unsupported conditions
    return {
      condition,
      guidelineSource: "General Clinical Practice",
      recommendations: [{
        priority: "first-line",
        therapy: "Consult specialist for condition-specific guidelines",
        rationale: "This condition requires specialized guideline-directed therapy.",
        contraindications: [],
        monitoring: "Per specialist recommendation",
      }],
      patientSpecificNotes: ["Condition not in current guideline database. Specialist consultation recommended."],
    };
  }

  private _afibRecommendations(
    context: { age: number | null; egfr: number | null; isFemale: boolean },
    condText: string,
    _medText: string,
    _allergyText: string,
  ): TherapeuticRecommendation {
    const notes: string[] = [];
    const recs: TherapeuticRecommendation["recommendations"] = [];

    // Anticoagulation
    if (context.egfr && context.egfr >= 25) {
      recs.push({
        priority: "first-line",
        therapy: "Apixaban 5mg BID (or 2.5mg BID if ≥2 of: age≥80, weight≤60kg, Cr≥1.5)",
        rationale: "DOACs preferred over warfarin per 2023 AHA/ACC/HRS guidelines. Apixaban has best safety profile in CKD.",
        contraindications: ["Mechanical heart valve", "Moderate-severe mitral stenosis", "Active major bleeding"],
        monitoring: "Renal function every 6 months. CBC annually. Signs of bleeding.",
      });
    } else if (context.egfr && context.egfr < 25) {
      recs.push({
        priority: "first-line",
        therapy: "Warfarin (target INR 2.0-3.0)",
        rationale: "DOACs have limited data in severe CKD (eGFR <25). Warfarin remains standard.",
        contraindications: ["Active bleeding", "Severe liver disease", "Non-adherence to INR monitoring"],
        monitoring: "INR weekly until stable, then every 2-4 weeks. Target TTR >70%.",
      });
      notes.push("⚠️ Severe CKD (eGFR <25): DOACs not recommended. Using warfarin.");
    }

    // Rate control
    recs.push({
      priority: "first-line",
      therapy: "Metoprolol succinate 25-200mg daily (rate control)",
      rationale: "Beta-blockers are first-line for rate control in AF per guidelines.",
      contraindications: ["Severe bradycardia", "Decompensated HF", "Severe asthma"],
      monitoring: "Heart rate target <110 bpm (lenient) or <80 bpm (strict). ECG periodically.",
    });

    if (condText.includes("heart failure")) {
      notes.push("Patient has HF: Digoxin may be added for rate control. Avoid non-DHP CCBs (diltiazem, verapamil).");
    }

    if (context.age && context.age > 75) {
      notes.push("Age >75: Higher bleeding risk. Use reduced DOAC doses where indicated. Monitor closely.");
    }

    return {
      condition: "Atrial Fibrillation",
      guidelineSource: "2023 AHA/ACC/HRS Guideline for AF Management",
      recommendations: recs,
      patientSpecificNotes: notes,
    };
  }

  private _hypertensionRecommendations(
    context: { age: number | null; egfr: number | null },
    condText: string,
    _medText: string,
    allergyText: string,
  ): TherapeuticRecommendation {
    const notes: string[] = [];
    const recs: TherapeuticRecommendation["recommendations"] = [];

    // First-line based on comorbidities
    if (condText.includes("diabetes") || condText.includes("kidney") || condText.includes("ckd")) {
      if (!allergyText.includes("ace") && !allergyText.includes("lisinopril")) {
        recs.push({
          priority: "first-line",
          therapy: "ACE inhibitor (Lisinopril 10-40mg daily) or ARB (Losartan 50-100mg daily)",
          rationale: "ACEi/ARB preferred in diabetes and CKD for renoprotective effects (KDIGO, ADA guidelines).",
          contraindications: ["Bilateral renal artery stenosis", "Pregnancy", "Angioedema history (for ACEi)", "Hyperkalemia >5.5"],
          monitoring: "Cr and K+ within 1-2 weeks of initiation. BP target <130/80.",
        });
      }
    }

    if (condText.includes("heart failure")) {
      recs.push({
        priority: "first-line",
        therapy: "Sacubitril/Valsartan (Entresto) 24/26mg BID, titrate to 97/103mg BID",
        rationale: "ARNI preferred in HFrEF for mortality benefit (PARADIGM-HF trial).",
        contraindications: ["Concurrent ACEi (36h washout)", "Angioedema history", "Pregnancy"],
        monitoring: "BP, K+, renal function. Titrate every 2-4 weeks.",
      });
    }

    recs.push({
      priority: condText.includes("diabetes") ? "second-line" : "first-line",
      therapy: "Amlodipine 5-10mg daily",
      rationale: "CCB effective for BP reduction. No metabolic effects. Good in elderly.",
      contraindications: ["Severe aortic stenosis", "Decompensated HF"],
      monitoring: "BP. Watch for peripheral edema.",
    });

    recs.push({
      priority: "avoid",
      therapy: "NSAIDs (ibuprofen, naproxen, ketorolac)",
      rationale: "NSAIDs counteract antihypertensives, cause fluid retention, and worsen CKD.",
      contraindications: [],
      monitoring: "",
    });

    if (context.egfr && context.egfr < 30) {
      notes.push("⚠️ Severe CKD: Avoid thiazide diuretics (ineffective at eGFR <30). Use loop diuretics if volume overload.");
    }

    return {
      condition: "Hypertension",
      guidelineSource: "2023 ESH Guidelines, 2021 KDIGO BP in CKD, AHA/ACC 2017",
      recommendations: recs,
      patientSpecificNotes: notes,
    };
  }

  private _diabetesRecommendations(
    context: { age: number | null; egfr: number | null },
    condText: string,
    medText: string,
    _allergyText: string,
  ): TherapeuticRecommendation {
    const notes: string[] = [];
    const recs: TherapeuticRecommendation["recommendations"] = [];

    // Metformin as first-line (if eGFR allows)
    if (!context.egfr || context.egfr >= 30) {
      recs.push({
        priority: "first-line",
        therapy: context.egfr && context.egfr < 45
          ? "Metformin 500mg BID (reduced dose for eGFR 30-45)"
          : "Metformin 500-1000mg BID",
        rationale: "Metformin remains first-line per ADA 2024 Standards of Care. Cost-effective, proven CV benefit.",
        contraindications: ["eGFR <30", "Acute/decompensated HF", "Hepatic impairment", "Active alcohol abuse"],
        monitoring: "HbA1c every 3 months until at goal, then every 6 months. Renal function annually. B12 levels if on >4 years.",
      });
    } else {
      notes.push("🚫 Metformin CONTRAINDICATED (eGFR <30). Alternative first-line needed.");
    }

    // SGLT2i if CV or renal benefit needed
    if (condText.includes("heart failure") || condText.includes("kidney") || condText.includes("ckd")) {
      if (!context.egfr || context.egfr >= 20) {
        recs.push({
          priority: "first-line",
          therapy: "Empagliflozin 10mg daily OR Dapagliflozin 10mg daily",
          rationale: "SGLT2i have proven CV and renal benefits independent of glucose control (EMPA-REG, DAPA-CKD, CREDENCE trials). Recommended regardless of HbA1c if HF or CKD present.",
          contraindications: ["eGFR <20 (for glucose benefit)", "Type 1 diabetes", "History of DKA", "Recurrent UTIs/genital infections"],
          monitoring: "Renal function. Watch for genital mycotic infections, volume depletion. Hold before surgery.",
        });
      }
    }

    // GLP-1 RA if CV disease or obesity
    if (condText.includes("cardiovascular") || condText.includes("atherosclerotic") || condText.includes("obesity")) {
      recs.push({
        priority: "first-line",
        therapy: "Semaglutide 0.25mg weekly, titrate to 1mg weekly (or Liraglutide 1.8mg daily)",
        rationale: "GLP-1 RA with proven CV benefit. Also promotes weight loss. Per ADA: preferred if ASCVD or high CV risk.",
        contraindications: ["Personal/family history of medullary thyroid carcinoma", "MEN2 syndrome", "Pancreatitis history"],
        monitoring: "HbA1c. Weight. GI side effects (nausea, usually transient). Lipase if abdominal pain.",
      });
    }

    recs.push({
      priority: "avoid",
      therapy: "Sulfonylureas (glipizide, glyburide) as initial therapy",
      rationale: "Higher hypoglycemia risk, weight gain, no CV benefit. Reserve for cost-constrained settings.",
      contraindications: [],
      monitoring: "",
    });

    if (medText.includes("insulin")) {
      notes.push("Patient already on insulin. Consider adding SGLT2i or GLP-1 RA for additional CV/renal benefit and potential insulin dose reduction.");
    }

    return {
      condition: "Type 2 Diabetes Mellitus",
      guidelineSource: "ADA Standards of Care 2024, KDIGO 2022 Diabetes in CKD",
      recommendations: recs,
      patientSpecificNotes: notes,
    };
  }

  private _heartFailureRecommendations(
    context: { egfr: number | null },
    condText: string,
    _medText: string,
    _allergyText: string,
  ): TherapeuticRecommendation {
    const notes: string[] = [];
    const recs: TherapeuticRecommendation["recommendations"] = [];

    // GDMT for HFrEF (Guideline-Directed Medical Therapy)
    recs.push({
      priority: "first-line",
      therapy: "Sacubitril/Valsartan (ARNI) - titrate to max tolerated dose",
      rationale: "PARADIGM-HF: 20% reduction in CV death/HF hospitalization vs enalapril. Foundation of HFrEF therapy.",
      contraindications: ["Concurrent ACEi", "Angioedema", "Pregnancy", "Severe hepatic impairment"],
      monitoring: "BP, K+, renal function every 1-2 weeks during titration.",
    });

    recs.push({
      priority: "first-line",
      therapy: "Beta-blocker: Carvedilol 3.125mg BID → 25mg BID, OR Metoprolol succinate 12.5mg → 200mg daily",
      rationale: "Proven mortality benefit in HFrEF (COPERNICUS, MERIT-HF). Only carvedilol, metoprolol succinate, or bisoprolol.",
      contraindications: ["Cardiogenic shock", "Severe bradycardia", "Decompensated HF (start after stabilization)"],
      monitoring: "HR, BP. Titrate every 2 weeks. Target resting HR 60-70.",
    });

    recs.push({
      priority: "first-line",
      therapy: "Dapagliflozin 10mg daily OR Empagliflozin 10mg daily",
      rationale: "DAPA-HF, EMPEROR-Reduced: Benefit in HFrEF regardless of diabetes status. Now part of foundational therapy.",
      contraindications: ["Type 1 diabetes", "eGFR <20"],
      monitoring: "Renal function, volume status, genital infections.",
    });

    recs.push({
      priority: "first-line",
      therapy: "Spironolactone 12.5-50mg daily (or Eplerenone 25-50mg daily)",
      rationale: "RALES trial: 30% mortality reduction. Essential in HFrEF with EF ≤35%.",
      contraindications: ["K+ >5.0", "eGFR <30 (relative)", "Concurrent K+ supplements"],
      monitoring: "K+ and Cr within 3 days, then 1 week, then monthly. Hold if K+ >5.5.",
    });

    recs.push({
      priority: "avoid",
      therapy: "NSAIDs, non-DHP CCBs (diltiazem, verapamil), thiazolidinediones (pioglitazone)",
      rationale: "NSAIDs cause fluid retention. Non-DHP CCBs are negative inotropes. TZDs worsen fluid overload.",
      contraindications: [],
      monitoring: "",
    });

    if (context.egfr && context.egfr < 30) {
      notes.push("⚠️ Severe CKD: Use spironolactone with extreme caution (hyperkalemia risk). Consider eplerenone. Monitor K+ closely.");
    }

    if (condText.includes("diabetes")) {
      notes.push("Diabetes + HF: SGLT2i provides dual benefit. Prioritize empagliflozin or dapagliflozin.");
    }

    return {
      condition: "Heart Failure (HFrEF)",
      guidelineSource: "2022 AHA/ACC/HFSA Guideline for HF Management, ESC 2023",
      recommendations: recs,
      patientSpecificNotes: notes,
    };
  }

  private _ckdRecommendations(
    context: { egfr: number | null },
    condText: string,
    _medText: string,
  ): TherapeuticRecommendation {
    const notes: string[] = [];
    const recs: TherapeuticRecommendation["recommendations"] = [];

    recs.push({
      priority: "first-line",
      therapy: "ACEi or ARB (max tolerated dose)",
      rationale: "Renoprotective. Reduces proteinuria and slows CKD progression (KDIGO 2024).",
      contraindications: ["Bilateral renal artery stenosis", "K+ >5.5", "Pregnancy"],
      monitoring: "Cr and K+ within 1-2 weeks. Accept up to 30% Cr rise. If >30%, investigate.",
    });

    if (condText.includes("diabetes")) {
      recs.push({
        priority: "first-line",
        therapy: "SGLT2i (Dapagliflozin 10mg or Empagliflozin 10mg) if eGFR ≥20",
        rationale: "DAPA-CKD, EMPA-KIDNEY: Slows CKD progression by 39% regardless of diabetes. Now standard of care.",
        contraindications: ["eGFR <20 for initiation", "Type 1 DM", "Recurrent DKA"],
        monitoring: "eGFR (expect initial dip of 10-15%, recovers). Volume status.",
      });
    }

    recs.push({
      priority: "first-line",
      therapy: "Finerenone 10-20mg daily (if diabetic CKD with albuminuria)",
      rationale: "FIDELIO-DKD, FIGARO-DKD: Non-steroidal MRA reduces CKD progression and CV events in diabetic kidney disease.",
      contraindications: ["K+ >5.0", "Severe hepatic impairment", "Concurrent strong CYP3A4 inhibitors"],
      monitoring: "K+ within 4 weeks. eGFR. Hold if K+ >5.5.",
    });

    recs.push({
      priority: "avoid",
      therapy: "NSAIDs, high-dose contrast dye, aminoglycosides, high-dose metformin (if eGFR <30)",
      rationale: "All are nephrotoxic or accumulate in CKD. Can precipitate acute-on-chronic kidney injury.",
      contraindications: [],
      monitoring: "",
    });

    if (context.egfr && context.egfr < 15) {
      notes.push("🔴 eGFR <15: Prepare for renal replacement therapy (dialysis or transplant). Nephrology should be actively involved.");
    }

    return {
      condition: "Chronic Kidney Disease",
      guidelineSource: "KDIGO 2024 CKD Guidelines, DAPA-CKD, EMPA-KIDNEY trials",
      recommendations: recs,
      patientSpecificNotes: notes,
    };
  }

  private async _fetchConditions(req: Request, patientId: string): Promise<string[]> {
    try {
      const bundle = await FhirClientInstance.search(req, "Condition", [`patient=${patientId}`, "clinical-status=active"]);
      if (!bundle?.entry?.length) return [];
      return bundle.entry.filter((e) => !!e.resource).map((e) => {
        const c = e.resource as fhirR4.Condition;
        return c.code?.text ?? c.code?.coding?.[0]?.display ?? "";
      });
    } catch { return []; }
  }

  private async _fetchMedications(req: Request, patientId: string): Promise<string[]> {
    try {
      const bundle = await FhirClientInstance.search(req, "MedicationRequest", [`patient=${patientId}`, "status=active"]);
      if (!bundle?.entry?.length) return [];
      return bundle.entry.filter((e) => !!e.resource).map((e) => {
        const m = e.resource as fhirR4.MedicationRequest;
        return m.medicationCodeableConcept?.text ?? m.medicationCodeableConcept?.coding?.[0]?.display ?? "";
      });
    } catch { return []; }
  }

  private async _fetchAllergies(req: Request, patientId: string): Promise<string[]> {
    try {
      const bundle = await FhirClientInstance.search(req, "AllergyIntolerance", [`patient=${patientId}`]);
      if (!bundle?.entry?.length) return [];
      return bundle.entry.filter((e) => !!e.resource).map((e) => {
        const a = e.resource as fhirR4.AllergyIntolerance;
        return a.code?.text ?? a.code?.coding?.[0]?.display ?? "";
      });
    } catch { return []; }
  }

  private async _fetchLabs(req: Request, patientId: string): Promise<Record<string, number>> {
    const labs: Record<string, number> = {};
    try {
      const bundle = await FhirClientInstance.search(req, "Observation", [`patient=${patientId}`, "category=laboratory", "_sort=-date", "_count=30"]);
      if (!bundle?.entry?.length) return labs;
      for (const entry of bundle.entry) {
        const obs = entry.resource as fhirR4.Observation;
        const display = (obs.code?.text ?? obs.code?.coding?.[0]?.display ?? "").toLowerCase();
        if (display.includes("creatinine") && !labs["creatinine"] && obs.valueQuantity?.value) {
          labs["creatinine"] = obs.valueQuantity.value;
        }
      }
    } catch { /* return what we have */ }
    return labs;
  }
}

export const RecommendTherapeuticPlanToolInstance = new RecommendTherapeuticPlanTool();
