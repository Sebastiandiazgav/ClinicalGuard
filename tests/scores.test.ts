import { describe, it, expect } from "vitest";
import { calculateCkdEpi } from "../clinical/scores/ckd-epi";
import { calculateHasBled } from "../clinical/scores/has-bled";
import { calculateCha2ds2Vasc } from "../clinical/scores/cha2ds2-vasc";
import { calculateWellsPe } from "../clinical/scores/wells";
import { calculateMeld } from "../clinical/scores/meld";

describe("CKD-EPI 2021 (eGFR Calculator)", () => {
  it("calculates normal eGFR for young healthy male", () => {
    const result = calculateCkdEpi({ creatinine: 0.9, age: 30, isFemale: false });
    expect(result.egfr).toBeGreaterThan(90);
    expect(result.ckdStage).toBe("G1");
    expect(result.requiresDoseAdjustment).toBe(false);
  });

  it("calculates reduced eGFR for elderly female with elevated creatinine", () => {
    const result = calculateCkdEpi({ creatinine: 1.8, age: 72, isFemale: true });
    expect(result.egfr).toBeLessThan(45);
    expect(result.ckdStage).toMatch(/G3b|G4/);
    expect(result.requiresDoseAdjustment).toBe(true);
  });

  it("detects CKD stage 3b for María García scenario (Cr 1.6, 72F)", () => {
    // María García: 72 years old, female, creatinine 1.6 mg/dL
    const result = calculateCkdEpi({ creatinine: 1.6, age: 72, isFemale: true });
    expect(result.egfr).toBeGreaterThanOrEqual(30);
    expect(result.egfr).toBeLessThan(45);
    expect(result.ckdStage).toBe("G3b");
    expect(result.requiresDoseAdjustment).toBe(true);
  });

  it("detects kidney failure (G5) for very high creatinine", () => {
    const result = calculateCkdEpi({ creatinine: 6.0, age: 55, isFemale: false });
    expect(result.egfr).toBeLessThan(15);
    expect(result.ckdStage).toBe("G5");
  });

  it("handles female sex factor correctly", () => {
    const male = calculateCkdEpi({ creatinine: 1.0, age: 50, isFemale: false });
    const female = calculateCkdEpi({ creatinine: 1.0, age: 50, isFemale: true });
    // Female should have slightly higher eGFR at same creatinine due to formula
    expect(female.egfr).not.toBe(male.egfr);
  });
});

describe("HAS-BLED Score (Bleeding Risk)", () => {
  it("calculates low risk for healthy patient", () => {
    const result = calculateHasBled({
      hypertension: false,
      abnormalRenalFunction: false,
      abnormalLiverFunction: false,
      strokeHistory: false,
      bleedingHistory: false,
      labileInr: false,
      elderly: false,
      drugsAntiplatelet: false,
      alcoholUse: false,
    });
    expect(result.score).toBe(0);
    expect(result.riskCategory).toBe("low");
  });

  it("calculates high risk for complex patient", () => {
    const result = calculateHasBled({
      hypertension: true,
      abnormalRenalFunction: true,
      abnormalLiverFunction: false,
      strokeHistory: true,
      bleedingHistory: false,
      labileInr: true,
      elderly: true,
      drugsAntiplatelet: true,
      alcoholUse: false,
    });
    expect(result.score).toBe(6);
    expect(result.riskCategory).toBe("high");
  });

  it("provides correct breakdown", () => {
    const result = calculateHasBled({
      hypertension: true,
      abnormalRenalFunction: false,
      abnormalLiverFunction: false,
      strokeHistory: false,
      bleedingHistory: false,
      labileInr: false,
      elderly: true,
      drugsAntiplatelet: false,
      alcoholUse: false,
    });
    expect(result.score).toBe(2);
    expect(result.riskCategory).toBe("moderate");
    expect(result.breakdown.filter((b) => b.present)).toHaveLength(2);
  });
});

describe("CHA₂DS₂-VASc Score (Stroke Risk)", () => {
  it("calculates low risk for young male with no risk factors", () => {
    const result = calculateCha2ds2Vasc({
      congestiveHeartFailure: false,
      hypertension: false,
      age: 45,
      diabetesMellitus: false,
      strokeTiaHistory: false,
      vascularDisease: false,
      isFemale: false,
    });
    expect(result.score).toBe(0);
    expect(result.riskCategory).toBe("low");
    expect(result.anticoagulationIndicated).toBe(false);
  });

  it("calculates high risk for elderly female with multiple factors", () => {
    const result = calculateCha2ds2Vasc({
      congestiveHeartFailure: true,
      hypertension: true,
      age: 76,
      diabetesMellitus: true,
      strokeTiaHistory: false,
      vascularDisease: false,
      isFemale: true,
    });
    // CHF(1) + HTN(1) + Age≥75(2) + DM(1) + Female(1) = 6
    expect(result.score).toBe(6);
    expect(result.riskCategory).toBe("high");
    expect(result.anticoagulationIndicated).toBe(true);
  });

  it("gives 2 points for stroke history", () => {
    const result = calculateCha2ds2Vasc({
      congestiveHeartFailure: false,
      hypertension: false,
      age: 50,
      diabetesMellitus: false,
      strokeTiaHistory: true,
      vascularDisease: false,
      isFemale: false,
    });
    expect(result.score).toBe(2);
    expect(result.anticoagulationIndicated).toBe(true);
  });
});

describe("Wells Score for PE", () => {
  it("calculates low probability with no risk factors", () => {
    const result = calculateWellsPe({
      clinicalSignsDvt: false,
      peIsTopDiagnosis: false,
      heartRateOver100: false,
      immobilizationOrSurgery: false,
      previousPeDvt: false,
      hemoptysis: false,
      malignancy: false,
    });
    expect(result.score).toBe(0);
    expect(result.riskCategory).toBe("low");
  });

  it("calculates high probability with multiple factors", () => {
    const result = calculateWellsPe({
      clinicalSignsDvt: true,
      peIsTopDiagnosis: true,
      heartRateOver100: true,
      immobilizationOrSurgery: false,
      previousPeDvt: true,
      hemoptysis: false,
      malignancy: false,
    });
    // DVT(3) + PE#1(3) + HR>100(1.5) + PrevPE(1.5) = 9
    expect(result.score).toBe(9);
    expect(result.riskCategory).toBe("high");
  });

  it("recommends D-dimer for low/moderate risk", () => {
    const result = calculateWellsPe({
      clinicalSignsDvt: false,
      peIsTopDiagnosis: false,
      heartRateOver100: true,
      immobilizationOrSurgery: false,
      previousPeDvt: false,
      hemoptysis: false,
      malignancy: false,
    });
    expect(result.recommendation).toContain("D-dimer");
  });
});

describe("MELD Score (Liver Disease)", () => {
  it("calculates low MELD for normal labs", () => {
    const result = calculateMeld({
      creatinine: 0.8,
      bilirubin: 0.7,
      inr: 1.0,
    });
    expect(result.meld).toBeLessThanOrEqual(10);
    expect(result.mortality3Month).toBe("1.9%");
  });

  it("calculates high MELD for severe liver disease", () => {
    const result = calculateMeld({
      creatinine: 2.5,
      bilirubin: 8.0,
      inr: 2.5,
    });
    expect(result.meld).toBeGreaterThan(25);
  });

  it("caps creatinine at 4.0 for dialysis patients", () => {
    const result = calculateMeld({
      creatinine: 8.0,
      bilirubin: 3.0,
      inr: 1.5,
      isOnDialysis: true,
    });
    // Should use creatinine = 4.0 regardless of actual value
    const resultWithCap = calculateMeld({
      creatinine: 4.0,
      bilirubin: 3.0,
      inr: 1.5,
    });
    expect(result.meld).toBe(resultWithCap.meld);
  });

  it("calculates MELD-Na when sodium provided", () => {
    const result = calculateMeld({
      creatinine: 1.5,
      bilirubin: 3.0,
      inr: 1.8,
      sodium: 128,
    });
    expect(result.meldNa).not.toBeNull();
    expect(result.meldNa!).toBeGreaterThan(result.meld);
  });
});
