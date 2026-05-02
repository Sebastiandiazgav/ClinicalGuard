import { describe, it, expect } from "vitest";
import { calculateSofa } from "../clinical/scores/sofa";
import { calculateHeart } from "../clinical/scores/heart";
import { calculateNews2 } from "../clinical/scores/news2";
import { calculateCurb65 } from "../clinical/scores/curb65";

describe("SOFA Score (Sepsis/Organ Failure)", () => {
  it("calculates low score for healthy patient", () => {
    const result = calculateSofa({
      pao2fio2: 450,
      platelets: 200,
      bilirubin: 0.8,
      meanArterialPressure: 80,
      glasgowComaScale: 15,
      creatinine: 0.9,
    });
    expect(result.totalScore).toBeLessThanOrEqual(1);
    expect(result.sepsisLikely).toBe(false);
  });

  it("detects sepsis with score ≥2", () => {
    const result = calculateSofa({
      pao2fio2: 250,
      platelets: 80,
      bilirubin: 3.0,
      meanArterialPressure: 60,
      glasgowComaScale: 13,
      creatinine: 2.5,
    });
    expect(result.totalScore).toBeGreaterThanOrEqual(2);
    expect(result.sepsisLikely).toBe(true);
  });

  it("identifies critical organs", () => {
    const result = calculateSofa({
      platelets: 15,
      creatinine: 6.0,
    });
    expect(result.criticalOrgans).toContain("Coagulation");
    expect(result.criticalOrgans).toContain("Renal");
  });

  it("scores vasopressor use correctly", () => {
    const result = calculateSofa({
      onVasopressors: true,
      vasopressorDose: "high",
    });
    expect(result.organScores.cardiovascular).toBe(4);
  });

  it("calculates high mortality for severe multi-organ failure", () => {
    const result = calculateSofa({
      pao2fio2: 80,
      onMechanicalVentilation: true,
      platelets: 10,
      bilirubin: 15,
      onVasopressors: true,
      vasopressorDose: "high",
      glasgowComaScale: 5,
      creatinine: 6.0,
    });
    expect(result.totalScore).toBeGreaterThanOrEqual(15);
    expect(result.mortalityEstimate).toBe(">80%");
  });
});

describe("HEART Score (Chest Pain / ACS)", () => {
  it("calculates low risk for young patient with atypical chest pain", () => {
    const result = calculateHeart({
      historyScore: 0,
      ecgScore: 0,
      age: 35,
      riskFactors: 0,
      troponinScore: 0,
    });
    expect(result.score).toBeLessThanOrEqual(3);
    expect(result.riskCategory).toBe("low");
    expect(result.disposition).toContain("DISCHARGE");
  });

  it("calculates high risk for elderly with ST changes and elevated troponin", () => {
    const result = calculateHeart({
      historyScore: 2,
      ecgScore: 2,
      age: 72,
      riskFactors: 4,
      troponinScore: 2,
    });
    expect(result.score).toBeGreaterThanOrEqual(7);
    expect(result.riskCategory).toBe("high");
    expect(result.disposition).toContain("CCU");
  });

  it("calculates moderate risk correctly", () => {
    const result = calculateHeart({
      historyScore: 1,
      ecgScore: 1,
      age: 55,
      riskFactors: 2,
      troponinScore: 0,
    });
    expect(result.score).toBeGreaterThanOrEqual(4);
    expect(result.score).toBeLessThanOrEqual(6);
    expect(result.riskCategory).toBe("moderate");
  });

  it("provides MACE risk estimate", () => {
    const result = calculateHeart({
      historyScore: 2,
      ecgScore: 2,
      age: 70,
      riskFactors: 3,
      troponinScore: 2,
    });
    expect(result.maceRisk6Weeks).toBeDefined();
    expect(result.maceRisk6Weeks.length).toBeGreaterThan(0);
  });
});

describe("NEWS2 (Early Warning Score)", () => {
  it("calculates low risk for normal vitals", () => {
    const result = calculateNews2({
      respirationRate: 16,
      spo2: 97,
      systolicBp: 130,
      pulseRate: 72,
      consciousness: "alert",
      temperature: 37.0,
    });
    expect(result.totalScore).toBe(0);
    expect(result.clinicalRisk).toBe("low");
  });

  it("detects high risk with multiple abnormal parameters", () => {
    const result = calculateNews2({
      respirationRate: 28,
      spo2: 89,
      systolicBp: 85,
      pulseRate: 135,
      consciousness: "voice",
      temperature: 39.5,
      isOnSupplementalO2: true,
    });
    expect(result.totalScore).toBeGreaterThanOrEqual(7);
    expect(result.clinicalRisk).toBe("high");
  });

  it("triggers medium risk for single extreme parameter", () => {
    const result = calculateNews2({
      respirationRate: 7, // Score 3 (extreme)
      spo2: 97,
      systolicBp: 130,
      pulseRate: 72,
      consciousness: "alert",
      temperature: 37.0,
    });
    // Single parameter score of 3 should trigger medium risk
    expect(result.clinicalRisk).toBe("medium");
  });

  it("adds 2 points for supplemental oxygen", () => {
    const withO2 = calculateNews2({
      respirationRate: 16,
      spo2: 97,
      systolicBp: 130,
      pulseRate: 72,
      consciousness: "alert",
      temperature: 37.0,
      isOnSupplementalO2: true,
    });
    const withoutO2 = calculateNews2({
      respirationRate: 16,
      spo2: 97,
      systolicBp: 130,
      pulseRate: 72,
      consciousness: "alert",
      temperature: 37.0,
      isOnSupplementalO2: false,
    });
    expect(withO2.totalScore - withoutO2.totalScore).toBe(2);
  });

  it("scores altered consciousness as 3", () => {
    const result = calculateNews2({
      respirationRate: 16,
      spo2: 97,
      systolicBp: 130,
      pulseRate: 72,
      consciousness: "pain",
      temperature: 37.0,
    });
    const consBreakdown = result.breakdown.find((b) => b.parameter === "Consciousness");
    expect(consBreakdown?.score).toBe(3);
  });
});

describe("CURB-65 (Pneumonia Severity)", () => {
  it("calculates low risk for young patient with no criteria", () => {
    const result = calculateCurb65({
      confusion: false,
      bun: 15,
      bunUnit: "mg/dL",
      respiratoryRate: 22,
      systolicBp: 120,
      diastolicBp: 75,
      age: 45,
    });
    expect(result.score).toBe(0);
    expect(result.riskCategory).toBe("low");
    expect(result.disposition).toContain("Outpatient");
  });

  it("calculates severe risk for elderly with all criteria", () => {
    const result = calculateCurb65({
      confusion: true,
      bun: 25,
      bunUnit: "mg/dL",
      respiratoryRate: 35,
      systolicBp: 80,
      diastolicBp: 55,
      age: 72,
    });
    expect(result.score).toBe(5);
    expect(result.riskCategory).toBe("severe");
    expect(result.disposition).toContain("ICU");
  });

  it("recommends hospital admission for score 2", () => {
    const result = calculateCurb65({
      confusion: true,
      bun: 15,
      respiratoryRate: 22,
      systolicBp: 120,
      diastolicBp: 75,
      age: 70,
    });
    expect(result.score).toBe(2);
    expect(result.riskCategory).toBe("moderate");
    expect(result.disposition).toContain("Hospital");
  });

  it("provides 30-day mortality estimate", () => {
    const result = calculateCurb65({
      confusion: false,
      age: 45,
    });
    expect(result.mortality30Day).toBeDefined();
  });
});
