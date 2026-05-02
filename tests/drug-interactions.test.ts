import { describe, it, expect } from "vitest";
import { checkDrugInteractions } from "../clinical/interactions/drug-database";

describe("Drug Interaction Checker", () => {
  it("detects no interactions for safe combination", () => {
    const result = checkDrugInteractions(["acetaminophen", "omeprazole"]);
    expect(result.hasInteractions).toBe(false);
    expect(result.overallRiskLevel).toBe("safe");
  });

  it("detects contraindicated warfarin + ketorolac", () => {
    const result = checkDrugInteractions(["warfarin", "ketorolac"]);
    expect(result.hasInteractions).toBe(true);
    expect(result.criticalCount).toBe(1);
    expect(result.overallRiskLevel).toBe("danger");
    expect(result.interactions[0]!.severity).toBe("contraindicated");
    expect(result.interactions[0]!.alternatives).toContain("acetaminophen");
  });

  it("detects severe warfarin + aspirin interaction", () => {
    const result = checkDrugInteractions(["warfarin", "aspirin"]);
    expect(result.hasInteractions).toBe(true);
    expect(result.severeCount).toBe(1);
    expect(result.overallRiskLevel).toBe("warning");
  });

  it("detects multiple interactions in complex regimen", () => {
    const result = checkDrugInteractions([
      "warfarin",
      "aspirin",
      "ibuprofen",
      "amiodarone",
    ]);
    expect(result.totalInteractions).toBeGreaterThanOrEqual(3);
    expect(result.overallRiskLevel).toBe("warning");
  });

  it("handles brand names (Coumadin = warfarin)", () => {
    const result = checkDrugInteractions(["Coumadin", "ketorolac"]);
    expect(result.hasInteractions).toBe(true);
    expect(result.criticalCount).toBe(1);
  });

  it("handles brand names (Toradol = ketorolac)", () => {
    const result = checkDrugInteractions(["warfarin", "Toradol"]);
    expect(result.hasInteractions).toBe(true);
    expect(result.criticalCount).toBe(1);
  });

  it("detects drug-condition interactions (ketorolac + renal impairment)", () => {
    const result = checkDrugInteractions(
      ["ketorolac"],
      ["renal_impairment"],
    );
    expect(result.hasInteractions).toBe(true);
    expect(result.criticalCount).toBe(1);
    expect(result.interactions[0]!.severity).toBe("contraindicated");
  });

  it("detects metformin + renal impairment", () => {
    const result = checkDrugInteractions(
      ["metformin"],
      ["renal_impairment"],
    );
    expect(result.hasInteractions).toBe(true);
    expect(result.severeCount).toBe(1);
  });

  it("detects sildenafil + nitrates as contraindicated", () => {
    const result = checkDrugInteractions(["sildenafil", "nitrates"]);
    expect(result.hasInteractions).toBe(true);
    expect(result.criticalCount).toBe(1);
    expect(result.overallRiskLevel).toBe("danger");
  });

  it("detects clopidogrel + omeprazole moderate interaction", () => {
    const result = checkDrugInteractions(["clopidogrel", "omeprazole"]);
    expect(result.hasInteractions).toBe(true);
    expect(result.moderateCount).toBe(1);
    expect(result.interactions[0]!.alternatives).toContain("pantoprazole");
  });

  it("sorts interactions by severity (most severe first)", () => {
    const result = checkDrugInteractions([
      "warfarin",
      "ketorolac",
      "clopidogrel",
      "omeprazole",
    ]);
    if (result.interactions.length >= 2) {
      const severityOrder = { contraindicated: 0, severe: 1, moderate: 2, mild: 3 };
      for (let i = 0; i < result.interactions.length - 1; i++) {
        const current = severityOrder[result.interactions[i]!.severity];
        const next = severityOrder[result.interactions[i + 1]!.severity];
        expect(current).toBeLessThanOrEqual(next);
      }
    }
  });

  it("provides meaningful summary", () => {
    const result = checkDrugInteractions(["warfarin", "ketorolac"]);
    expect(result.summary).toContain("IMMEDIATE ACTION REQUIRED");
    expect(result.summary).toContain("contraindicated");
  });

  it("handles empty medication list", () => {
    const result = checkDrugInteractions([]);
    expect(result.hasInteractions).toBe(false);
    expect(result.overallRiskLevel).toBe("safe");
  });

  it("handles single medication (no pairs to check)", () => {
    const result = checkDrugInteractions(["warfarin"]);
    expect(result.hasInteractions).toBe(false);
  });
});
