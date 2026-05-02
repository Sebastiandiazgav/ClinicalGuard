# 🏥 ClinicalGuard AI

**Intelligent Clinical Safety System**  
*MCP Server for healthcare AI applications*

---

## 🎯 What It Does

ClinicalGuard AI acts as an intelligent safety layer between clinicians and medical actions. It intercepts, validates, and enriches medical decisions in real-time.

### Available Tools

| Tool | Purpose |
|------|---------|
| `ValidateDrugInteractions` | Detect drug-drug and drug-condition interactions |
| `CalculateClinicalRisk` | Compute clinical risk scores (CHA₂DS₂-VASc, HAS-BLED, Wells, MELD, CKD-EPI) |
| `AdjustDosageRenal` | Calculate eGFR and adjust medication doses for renal impairment |
| `GenerateClinicalSummary` | Aggregate patient data into comprehensive clinical summary |
| `AuditSharpChain` | Validate SHARP context integrity and compliance |
| `DetectClinicalAlerts` | Proactively detect critical labs, sepsis, deterioration |
| `RecommendTherapeuticPlan` | Evidence-based therapy recommendations per guidelines |
| `PredictDeteriorationRisk` | Predict clinical decline 24-48h before crisis |
| `GenerateHandoffSBAR` | Structured SBAR communication for clinical handoffs |

---

## 📊 Clinical Knowledge Base

- **61 drug interactions** with severity, mechanism, and alternatives
- **23 medications** with renal dose adjustments
- **10 medications** with hepatic dose adjustments
- **7 validated clinical scores** with peer-reviewed formulas

---

## 🚀 Quick Start

### Prerequisites
- Node.js 18+
- npm

### Setup

```bash
cd clinicalguard
npm install
cp .env.example .env  # Create environment file
npm start
```

Server runs on `http://localhost:5000`

---

## 🔒 Security

- SHARP-on-MCP compliant
- JWT validation
- No data storage (stateless)
- Full audit trail

---

## 🧪 Testing

```bash
npm test
```

**50 unit tests** covering clinical logic.

---

## 📄 License

MIT

---

## 👥 Team

Built for the **Agents Assemble: The Healthcare AI Endgame** hackathon.
