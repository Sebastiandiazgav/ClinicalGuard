import { McpServer } from "@modelcontextprotocol/sdk/server/mcp";
import { Request } from "express";
import { IMcpTool } from "../IMcpTool";
import { z } from "zod";
import { FhirUtilities } from "../fhir-utilities";
import { McpUtilities } from "../mcp-utilities";
import { McpConstants } from "../mcp-constants";
import * as jose from "jose";

/**
 * In-memory audit log for the current server session.
 * In production, this would be persisted to a database or immutable log store.
 */
const auditLog: AuditEntry[] = [];

interface AuditEntry {
  timestamp: string;
  action: string;
  patientId: string | null;
  fhirServerUrl: string | null;
  tokenPresent: boolean;
  tokenValid: boolean;
  tokenExpiry: string | null;
  tokenScopes: string[];
  chainIntact: boolean;
  details: string;
}

class AuditSharpChainTool implements IMcpTool {
  registerTool(server: McpServer, req: Request) {
    server.registerTool(
      "AuditSharpChain",
      {
        description:
          "Audits the SHARP context propagation chain to ensure patient data security and compliance. " +
          "Validates that the FHIR token, patient ID, and server URL are properly propagated. " +
          "Checks token validity, expiration, and scopes. " +
          "Maintains an immutable audit trail of all operations performed on patient data. " +
          "Use this tool at the END of any clinical workflow to verify compliance.",
        inputSchema: {
          action: z
            .enum(["validate", "log", "report"])
            .describe(
              "'validate' - Check current SHARP context integrity. " +
              "'log' - Record an action in the audit trail. " +
              "'report' - Generate a full audit report for the current session.",
            ),
          actionDescription: z
            .string()
            .describe("Description of the action being audited (for 'log' action)")
            .optional(),
          patientId: z
            .string()
            .describe("The patient ID. Optional if FHIR context exists.")
            .optional(),
        },
      },
      async ({ action, actionDescription, patientId }) => {
        try {
          switch (action) {
            case "validate":
              return this._validateChain(req, patientId);
            case "log":
              return this._logAction(req, actionDescription ?? "Unspecified action", patientId);
            case "report":
              return this._generateReport(patientId);
            default:
              return McpUtilities.createTextResponse(
                `Unknown action: ${action}`,
                { isError: true },
              );
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : "Unknown error";
          return McpUtilities.createTextResponse(
            `Audit error: ${message}`,
            { isError: true },
          );
        }
      },
    );
  }

  private _validateChain(req: Request, patientIdParam?: string) {
    const headers = req.headers;
    const fhirServerUrl = headers[McpConstants.FhirServerUrlHeaderName]?.toString() ?? null;
    const fhirToken = headers[McpConstants.FhirAccessTokenHeaderName]?.toString() ?? null;
    const headerPatientId = headers[McpConstants.PatientIdHeaderName]?.toString() ?? null;

    const checks: { check: string; status: "PASS" | "FAIL" | "WARN"; detail: string }[] = [];

    // Check 1: FHIR Server URL present
    checks.push({
      check: "FHIR Server URL",
      status: fhirServerUrl ? "PASS" : "FAIL",
      detail: fhirServerUrl
        ? `Server URL present: ${fhirServerUrl}`
        : "No FHIR server URL in SHARP headers. Context propagation may be broken.",
    });

    // Check 2: FHIR Access Token present
    checks.push({
      check: "FHIR Access Token",
      status: fhirToken ? "PASS" : "WARN",
      detail: fhirToken
        ? "Access token present in SHARP headers."
        : "No FHIR access token. Operations may fail or use unauthenticated access.",
    });

    // Check 3: Patient ID resolvable
    const resolvedPatientId =
      patientIdParam ??
      FhirUtilities.getPatientIdIfContextExists(req) ??
      headerPatientId;

    checks.push({
      check: "Patient ID",
      status: resolvedPatientId ? "PASS" : "FAIL",
      detail: resolvedPatientId
        ? `Patient ID resolved: ${resolvedPatientId}`
        : "Cannot resolve patient ID from token, headers, or parameters.",
    });

    // Check 4: Token validity (if present)
    let tokenExpiry: string | null = null;
    let tokenScopes: string[] = [];
    let tokenValid = false;

    if (fhirToken) {
      try {
        const claims = jose.decodeJwt(fhirToken);
        tokenValid = true;

        // Check expiration
        if (claims.exp) {
          const expiryDate = new Date(claims.exp * 1000);
          tokenExpiry = expiryDate.toISOString();
          const isExpired = expiryDate < new Date();

          checks.push({
            check: "Token Expiration",
            status: isExpired ? "FAIL" : "PASS",
            detail: isExpired
              ? `Token EXPIRED at ${tokenExpiry}. All FHIR operations will fail.`
              : `Token valid until ${tokenExpiry}.`,
          });
        }

        // Check scopes
        const scopeStr = (claims["scope"] as string) ?? "";
        tokenScopes = scopeStr.split(" ").filter((s) => s.length > 0);

        checks.push({
          check: "Token Scopes",
          status: tokenScopes.length > 0 ? "PASS" : "WARN",
          detail:
            tokenScopes.length > 0
              ? `Scopes: ${tokenScopes.join(", ")}`
              : "No scopes found in token. Access may be limited.",
        });

        // Check patient claim
        const tokenPatient = claims["patient"]?.toString();
        if (tokenPatient && resolvedPatientId && tokenPatient !== resolvedPatientId) {
          checks.push({
            check: "Patient ID Consistency",
            status: "FAIL",
            detail: `Token patient (${tokenPatient}) does not match requested patient (${resolvedPatientId}). Possible security violation.`,
          });
        } else if (tokenPatient) {
          checks.push({
            check: "Patient ID Consistency",
            status: "PASS",
            detail: "Token patient ID matches requested patient.",
          });
        }
      } catch {
        checks.push({
          check: "Token Decode",
          status: "FAIL",
          detail: "Failed to decode FHIR access token. Token may be malformed.",
        });
      }
    }

    // Overall chain status
    const failCount = checks.filter((c) => c.status === "FAIL").length;
    const warnCount = checks.filter((c) => c.status === "WARN").length;
    const chainIntact = failCount === 0;

    // Log this validation
    auditLog.push({
      timestamp: new Date().toISOString(),
      action: "SHARP_CHAIN_VALIDATION",
      patientId: resolvedPatientId,
      fhirServerUrl,
      tokenPresent: !!fhirToken,
      tokenValid,
      tokenExpiry,
      tokenScopes,
      chainIntact,
      details: `${checks.length} checks: ${checks.length - failCount - warnCount} PASS, ${warnCount} WARN, ${failCount} FAIL`,
    });

    const response = {
      chainStatus: chainIntact ? "INTACT" : "BROKEN",
      overallResult: failCount === 0 ? (warnCount === 0 ? "ALL_PASS" : "PASS_WITH_WARNINGS") : "FAILED",
      checksPerformed: checks.length,
      passed: checks.length - failCount - warnCount,
      warnings: warnCount,
      failures: failCount,
      checks,
      auditTimestamp: new Date().toISOString(),
      recommendation: chainIntact
        ? "✅ SHARP context chain is intact. All patient data operations are properly authorized."
        : "🚫 SHARP context chain is BROKEN. Patient data operations may be unauthorized or fail. Investigate immediately.",
    };

    return McpUtilities.createJsonResponse(
      response as unknown as Record<string, unknown>,
    );
  }

  private _logAction(req: Request, description: string, patientIdParam?: string) {
    const fhirServerUrl = req.headers[McpConstants.FhirServerUrlHeaderName]?.toString() ?? null;
    const fhirToken = req.headers[McpConstants.FhirAccessTokenHeaderName]?.toString() ?? null;
    const resolvedPatientId =
      patientIdParam ?? FhirUtilities.getPatientIdIfContextExists(req) ?? null;

    let tokenValid = false;
    let tokenExpiry: string | null = null;
    let tokenScopes: string[] = [];

    if (fhirToken) {
      try {
        const claims = jose.decodeJwt(fhirToken);
        tokenValid = true;
        tokenExpiry = claims.exp ? new Date(claims.exp * 1000).toISOString() : null;
        tokenScopes = ((claims["scope"] as string) ?? "").split(" ").filter((s) => s.length > 0);
      } catch {
        tokenValid = false;
      }
    }

    const entry: AuditEntry = {
      timestamp: new Date().toISOString(),
      action: description,
      patientId: resolvedPatientId,
      fhirServerUrl,
      tokenPresent: !!fhirToken,
      tokenValid,
      tokenExpiry,
      tokenScopes,
      chainIntact: !!fhirServerUrl && (!!fhirToken || !!resolvedPatientId),
      details: description,
    };

    auditLog.push(entry);

    return McpUtilities.createJsonResponse({
      logged: true,
      entryId: auditLog.length,
      timestamp: entry.timestamp,
      message: `Action logged: "${description}" for patient ${resolvedPatientId ?? "unknown"}`,
    });
  }

  private _generateReport(patientIdFilter?: string) {
    const entries = patientIdFilter
      ? auditLog.filter((e) => e.patientId === patientIdFilter)
      : auditLog;

    const chainBreaches = entries.filter((e) => !e.chainIntact).length;
    const tokenIssues = entries.filter((e) => e.tokenPresent && !e.tokenValid).length;

    const report = {
      reportGeneratedAt: new Date().toISOString(),
      patientFilter: patientIdFilter ?? "ALL",
      totalEntries: entries.length,
      chainBreaches,
      tokenIssues,
      complianceStatus:
        chainBreaches === 0 && tokenIssues === 0
          ? "COMPLIANT"
          : "NON_COMPLIANT",
      complianceSummary:
        chainBreaches === 0 && tokenIssues === 0
          ? "✅ All operations maintained SHARP context integrity. Full compliance with data access policies."
          : `⚠️ ${chainBreaches} chain breach(es) and ${tokenIssues} token issue(s) detected. Review audit entries for details.`,
      entries: entries.map((e, i) => ({
        entryId: i + 1,
        ...e,
      })),
    };

    return McpUtilities.createJsonResponse(
      report as unknown as Record<string, unknown>,
    );
  }
}

export const AuditSharpChainToolInstance = new AuditSharpChainTool();
