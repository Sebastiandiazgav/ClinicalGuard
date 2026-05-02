/**
 * FHIR Context - Propagated by Prompt Opinion via SHARP headers.
 * Contains the FHIR server URL and access token for the current patient session.
 */
export type FhirContext = {
  url: string;
  token?: string;
};
