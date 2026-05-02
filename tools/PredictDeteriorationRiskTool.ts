import { McpServer } from "@modelcontextprotocol/sdk/server/mcp";
import { Request } from "express";
import { IMcpTool } from "../IMcpTool";
import { z } from "zod";
import { FhirClientInstance } from "../fhir-client";
import { FhirUtilities } from "../fhir-utilities";
import { McpUtilities } from "../mcp-utilities";
import { NullUtilities } from "../null-utilities";
import { calculateNews2 } from "../clinical/scores/news2";
import { fhirR4 } from "@smile-cdr/fhirts";

interface VitalTrend {
  parameter: string;
  values: { value: number; timestamp: string }[];
  trend: "improving" | "stable" | "worsening" | "critical_worsening";
  changePercent: number;
  prediction: string;
}

class PredictDeteriorationRiskTool implements IMcpTool {
  registerTool(server: McpServer, req: Request) {
    server.registerTool(
      "PredictDeteriorationRisk",
      {
        description:
          "Analyzes trends in vital signs and laboratory values over time to predict " +
          "clinical deterioration risk within the next 24-48 hours. " +
          "Uses NEWS2 (National Early Warning Score 2) combined with trend analysis " +
          "to identify patients at risk of rapid decline BEFORE it happens. " +
          "This is a proactive early warning system — not reactive. " +
          "Use this for any patient in acute care to assess trajectory.",
        inputSchema: {
          patientId: z
            .string()
            .describe("The patient ID. Optional if FHIR context exists.")
            .optional(),
          hoursLookback: z
            .number()
            .describe("How many hours of data to analyze for trends. Default 24.")
            .optional(),
        },
      },
      async ({ patientId, hoursLookback }) => {
        try {
          if (!patientId) {
            patientId = NullUtilities.getOrThrow(
              FhirUtilities.getPatientIdIfContextExists(req),
              "Patient ID is required.",
            );
          }

          const lookback = hoursLookback ?? 24;

          // Fetch all observations sorted by date
          const observations = await this._fetchTimeSeriesObservations(req, patientId);

          // Calculate current NEWS2
          const currentNews2 = this._calculateCurrentNews2(observations);

          // Analyze trends for each vital parameter
          const trends = this._analyzeTrends(observations, lookback);

          // Calculate deterioration risk
          const riskAssessment = this._assessDeteriorationRisk(currentNews2, trends);

          const response = {
            patientId,
            assessmentTimestamp: new Date().toISOString(),
            lookbackHours: lookback,
            currentNews2Score: currentNews2,
            deteriorationRisk: riskAssessment,
            vitalTrends: trends,
            earlyWarnings: this._generateEarlyWarnings(trends, currentNews2),
            recommendedActions: this._getRecommendedActions(riskAssessment.riskLevel),
          };

          return McpUtilities.createJsonResponse(
            response as unknown as Record<string, unknown>,
          );
        } catch (error) {
          const message = error instanceof Error ? error.message : "Unknown error";
          return McpUtilities.createTextResponse(
            `Error predicting deterioration risk: ${message}`,
            { isError: true },
          );
        }
      },
    );
  }

  private _calculateCurrentNews2(observations: TimeSeriesObs[]): { score: number; risk: string } | null {
    // Get most recent values for NEWS2
    const latest = (param: string) => {
      const obs = observations
        .filter((o) => o.parameter === param)
        .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
      return obs[0]?.value;
    };

    const rr = latest("respiratory_rate");
    const spo2 = latest("spo2");
    const sbp = latest("systolic_bp");
    const hr = latest("heart_rate");
    const temp = latest("temperature");

    if (!rr && !spo2 && !sbp && !hr && !temp) return null;

    const result = calculateNews2({
      respirationRate: rr,
      spo2,
      systolicBp: sbp,
      pulseRate: hr,
      temperature: temp,
      consciousness: "alert", // Default if not available
      isOnSupplementalO2: false,
    });

    return { score: result.totalScore, risk: result.clinicalRisk };
  }

  private _analyzeTrends(observations: TimeSeriesObs[], lookbackHours: number): VitalTrend[] {
    const trends: VitalTrend[] = [];
    const cutoff = new Date(Date.now() - lookbackHours * 60 * 60 * 1000);

    const parameters = ["heart_rate", "systolic_bp", "respiratory_rate", "spo2", "temperature", "creatinine", "lactate"];

    for (const param of parameters) {
      const paramObs = observations
        .filter((o) => o.parameter === param && new Date(o.timestamp) >= cutoff)
        .sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());

      if (paramObs.length < 2) continue;

      const values = paramObs.map((o) => ({ value: o.value, timestamp: o.timestamp }));
      const firstValue = values[0]!.value;
      const lastValue = values[values.length - 1]!.value;
      const changePercent = ((lastValue - firstValue) / firstValue) * 100;

      // Determine trend direction and severity
      const trend = this._classifyTrend(param, values, changePercent);
      const prediction = this._predictNextValue(param, values);

      trends.push({
        parameter: this._getParameterDisplayName(param),
        values,
        trend,
        changePercent: Math.round(changePercent * 10) / 10,
        prediction,
      });
    }

    return trends;
  }

  private _classifyTrend(
    param: string,
    values: { value: number; timestamp: string }[],
    changePercent: number,
  ): VitalTrend["trend"] {
    // Parameters where INCREASE is bad
    const increaseIsBad = ["heart_rate", "respiratory_rate", "creatinine", "lactate", "temperature"];
    // Parameters where DECREASE is bad
    const decreaseIsBad = ["systolic_bp", "spo2"];

    const isBadDirection = increaseIsBad.includes(param)
      ? changePercent > 0
      : decreaseIsBad.includes(param)
        ? changePercent < 0
        : false;

    const absChange = Math.abs(changePercent);

    if (!isBadDirection) {
      if (absChange < 5) return "stable";
      return "improving";
    }

    // Bad direction
    if (absChange > 20) return "critical_worsening";
    if (absChange > 10) return "worsening";

    // Check for accelerating trend (getting worse faster)
    if (values.length >= 3) {
      const midIdx = Math.floor(values.length / 2);
      const firstHalfChange = values[midIdx]!.value - values[0]!.value;
      const secondHalfChange = values[values.length - 1]!.value - values[midIdx]!.value;

      if (Math.abs(secondHalfChange) > Math.abs(firstHalfChange) * 1.5) {
        return "worsening"; // Accelerating deterioration
      }
    }

    return absChange > 5 ? "worsening" : "stable";
  }

  private _predictNextValue(param: string, values: { value: number }[]): string {
    if (values.length < 3) return "Insufficient data for prediction";

    // Simple linear regression for next 6 hours
    const n = values.length;
    const xMean = (n - 1) / 2;
    const yMean = values.reduce((s, v) => s + v.value, 0) / n;

    let numerator = 0;
    let denominator = 0;
    for (let i = 0; i < n; i++) {
      numerator += (i - xMean) * (values[i]!.value - yMean);
      denominator += (i - xMean) * (i - xMean);
    }

    const slope = denominator !== 0 ? numerator / denominator : 0;
    const predictedNext = values[n - 1]!.value + slope * 2; // ~6 hours ahead

    const displayName = this._getParameterDisplayName(param);
    return `If current trend continues, ${displayName} predicted to be ~${Math.round(predictedNext * 10) / 10} in 6 hours.`;
  }

  private _assessDeteriorationRisk(
    news2: { score: number; risk: string } | null,
    trends: VitalTrend[],
  ): { riskLevel: "low" | "moderate" | "high" | "critical"; riskScore: number; reasoning: string[] } {
    let riskScore = 0;
    const reasoning: string[] = [];

    // NEWS2 contribution
    if (news2) {
      if (news2.score >= 7) { riskScore += 40; reasoning.push(`NEWS2 score ${news2.score} (HIGH risk)`); }
      else if (news2.score >= 5) { riskScore += 25; reasoning.push(`NEWS2 score ${news2.score} (MEDIUM risk)`); }
      else if (news2.score >= 1) { riskScore += 10; reasoning.push(`NEWS2 score ${news2.score} (low-medium risk)`); }
    }

    // Trend contribution
    for (const trend of trends) {
      if (trend.trend === "critical_worsening") {
        riskScore += 25;
        reasoning.push(`${trend.parameter}: CRITICAL worsening (${trend.changePercent}% change)`);
      } else if (trend.trend === "worsening") {
        riskScore += 15;
        reasoning.push(`${trend.parameter}: worsening trend (${trend.changePercent}% change)`);
      }
    }

    // Multiple worsening parameters = compounding risk
    const worseningCount = trends.filter((t) => t.trend === "worsening" || t.trend === "critical_worsening").length;
    if (worseningCount >= 3) {
      riskScore += 20;
      reasoning.push(`${worseningCount} parameters simultaneously worsening — multi-system deterioration pattern`);
    }

    let riskLevel: "low" | "moderate" | "high" | "critical";
    if (riskScore >= 70) riskLevel = "critical";
    else if (riskScore >= 45) riskLevel = "high";
    else if (riskScore >= 20) riskLevel = "moderate";
    else riskLevel = "low";

    return { riskLevel, riskScore: Math.min(riskScore, 100), reasoning };
  }

  private _generateEarlyWarnings(trends: VitalTrend[], news2: { score: number } | null): string[] {
    const warnings: string[] = [];

    if (news2 && news2.score >= 5) {
      warnings.push(`🔴 NEWS2 score ${news2.score} — patient at medium/high risk of deterioration NOW`);
    }

    for (const trend of trends) {
      if (trend.trend === "critical_worsening") {
        warnings.push(`🚨 ${trend.parameter} is critically worsening (${trend.changePercent}% change). Immediate review needed.`);
      } else if (trend.trend === "worsening") {
        warnings.push(`⚠️ ${trend.parameter} showing worsening trend. Monitor closely.`);
      }
    }

    const worseningCount = trends.filter((t) => t.trend === "worsening" || t.trend === "critical_worsening").length;
    if (worseningCount >= 2) {
      warnings.push(`🔴 MULTI-SYSTEM DETERIORATION: ${worseningCount} parameters worsening simultaneously. High risk of clinical decline within 24h.`);
    }

    if (warnings.length === 0) {
      warnings.push("✅ No early warning signs detected. Patient trajectory appears stable.");
    }

    return warnings;
  }

  private _getRecommendedActions(riskLevel: string): string[] {
    switch (riskLevel) {
      case "critical":
        return [
          "IMMEDIATE senior clinician review",
          "Consider ICU/HDU transfer",
          "Continuous vital sign monitoring",
          "Activate rapid response team",
          "Prepare for potential intubation/resuscitation",
          "Notify family of clinical deterioration",
        ];
      case "high":
        return [
          "Urgent clinician review within 30 minutes",
          "Increase monitoring to every 15-30 minutes",
          "Consider escalation to critical care outreach",
          "Review and optimize current treatment plan",
          "Ensure IV access and emergency medications available",
        ];
      case "moderate":
        return [
          "Clinician review within 1 hour",
          "Increase monitoring frequency to hourly",
          "Review current medications and interventions",
          "Reassess in 4-6 hours for trend changes",
          "Document deterioration risk in clinical notes",
        ];
      default:
        return [
          "Continue routine monitoring per protocol",
          "Reassess if any clinical change noted",
          "Standard care plan continues",
        ];
    }
  }

  private _getParameterDisplayName(param: string): string {
    const names: Record<string, string> = {
      heart_rate: "Heart Rate",
      systolic_bp: "Systolic BP",
      respiratory_rate: "Respiratory Rate",
      spo2: "SpO2",
      temperature: "Temperature",
      creatinine: "Creatinine",
      lactate: "Lactate",
    };
    return names[param] ?? param;
  }

  private async _fetchTimeSeriesObservations(req: Request, patientId: string): Promise<TimeSeriesObs[]> {
    const results: TimeSeriesObs[] = [];
    try {
      const bundle = await FhirClientInstance.search(req, "Observation", [
        `patient=${patientId}`,
        "_sort=-date",
        "_count=100",
      ]);

      if (!bundle?.entry?.length) return results;

      for (const entry of bundle.entry) {
        if (!entry.resource) continue;
        const obs = entry.resource as fhirR4.Observation;
        const display = (obs.code?.text ?? obs.code?.coding?.[0]?.display ?? "").toLowerCase();
        const value = obs.valueQuantity?.value;
        const timestamp = obs.effectiveDateTime ?? obs.issued ?? "";

        if (value === undefined || !timestamp) continue;

        let parameter: string | null = null;
        if (display.includes("heart rate") || display.includes("pulse")) parameter = "heart_rate";
        else if (display.includes("systolic")) parameter = "systolic_bp";
        else if (display.includes("respiratory")) parameter = "respiratory_rate";
        else if (display.includes("oxygen") || display.includes("spo2")) parameter = "spo2";
        else if (display.includes("temperature")) parameter = "temperature";
        else if (display.includes("creatinine")) parameter = "creatinine";
        else if (display.includes("lactate")) parameter = "lactate";

        if (parameter) {
          results.push({ parameter, value, timestamp });
        }
      }
    } catch {
      // Return what we have
    }

    return results;
  }
}

interface TimeSeriesObs {
  parameter: string;
  value: number;
  timestamp: string;
}

export const PredictDeteriorationRiskToolInstance = new PredictDeteriorationRiskTool();
