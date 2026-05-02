/**
 * SHARP-on-MCP Header Constants.
 * These headers are sent by Prompt Opinion to propagate FHIR context
 * through the MCP tool call chain.
 */
export const McpConstants = {
  FhirServerUrlHeaderName: "x-fhir-server-url",
  FhirAccessTokenHeaderName: "x-fhir-access-token",
  PatientIdHeaderName: "x-patient-id",
};
