import "dotenv/config";
import * as tools from "./tools";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp";
import { IMcpTool } from "./IMcpTool";
import cors from "cors";

const env = process.env["PO_ENV"]?.toString();
const port = process.env["PORT"] || 5000;

/**
 * MCP SDK host validation behavior (v1.29.0):
 * 
 * - If allowedHosts is provided → strict validation against that list
 * - If allowedHosts is NOT provided and host is '0.0.0.0' → no validation (warning only)
 * - If allowedHosts is NOT provided and host is 'localhost' → localhost-only validation
 * 
 * For local development with ngrok: host='0.0.0.0', no allowedHosts → accepts any host
 * For production: host='0.0.0.0', allowedHosts=['specific.domain.com'] → strict validation
 */
const mcpExpressOptions: { host: string; allowedHosts?: string[] } = {
  host: "0.0.0.0",
};

// Only restrict hosts in deployed environments
if (env === "dev") {
  mcpExpressOptions.allowedHosts = ["ts.fhir-mcp.dev.promptopinion.ai"];
} else if (env === "prod") {
  mcpExpressOptions.allowedHosts = ["ts.fhir-mcp.promptopinion.ai"];
}
// Local mode (default): no allowedHosts = accept all hosts (ngrok, tunnels, etc.)

const app = createMcpExpressApp(mcpExpressOptions);

app.use(cors());

// Health check endpoint
app.get("/health", async (_req, res) => {
  res.json({
    status: "healthy",
    service: "ClinicalGuard AI MCP Server",
    version: "1.0.0",
    tools: Object.keys(tools).length,
    environment: env ?? "local",
    timestamp: new Date().toISOString(),
  });
});

// MCP endpoint - handles all tool calls from Prompt Opinion
app.post("/mcp", async (req, res) => {
  try {
    const server = new McpServer(
      {
        name: "ClinicalGuard AI",
        version: "1.0.0",
      },
      {
        capabilities: {
          extensions: {
            "ai.promptopinion/fhir-context": {
              scopes: [
                { name: "patient/Patient.rs", required: true },
                { name: "offline_access" },
                { name: "patient/Observation.rs" },
                { name: "patient/Condition.rs" },
                { name: "patient/MedicationRequest.rs" },
                { name: "patient/MedicationStatement.rs" },
                { name: "patient/AllergyIntolerance.rs" },
                { name: "patient/Procedure.rs" },
              ],
            },
          },
        },
      },
    );

    // Register all ClinicalGuard tools
    for (const tool of Object.values<IMcpTool>(tools)) {
      tool.registerTool(server, req);
    }

    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });

    res.on("close", () => {
      console.log("Request closed");
      transport.close();
      server.close();
    });

    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (error) {
    console.error("Error handling MCP request:", error);
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: "2.0",
        error: {
          code: -32603,
          message: "Internal server error",
        },
        id: null,
      });
    }
  }
});

app.listen(port, () => {
  console.log(`
╔══════════════════════════════════════════════════════════════╗
║                                                              ║
║   🏥 ClinicalGuard AI - MCP Server                          ║
║   Intelligent Clinical Safety System                         ║
║                                                              ║
║   Port: ${String(port).padEnd(49)}║
║   Environment: ${String(env ?? "local").padEnd(43)}║
║   Tools: ${String(Object.keys(tools).length).padEnd(49)}║
║                                                              ║
║   Tools Available:                                           ║
║   • ValidateDrugInteractions                                 ║
║   • CalculateClinicalRisk                                    ║
║   • AdjustDosageRenal                                        ║
║   • GenerateClinicalSummary                                  ║
║   • DetectClinicalAlerts                                     ║
║   • RecommendTherapeuticPlan                                 ║
║   • PredictDeteriorationRisk                                 ║
║   • GenerateHandoffSBAR                                      ║
║   • AuditSharpChain                                          ║
║                                                              ║
║   MCP Endpoint: http://localhost:${String(port).padEnd(24)}║
║   Health Check: http://localhost:${String(port + "/health").padEnd(24)}║
║                                                              ║
╚══════════════════════════════════════════════════════════════╝
  `);
});
