---
name: research-prd
description: "Generate a structured requirements document for research efforts — stories produce decision documents with citations, not code. Human decision gates between research phases. Triggers on: research prd, create research prd, plan research, research sprint."
version: "1.0"
---

# Research PRD Generator

Create detailed requirements documents for **research efforts** where stories produce documents, analysis, and recommendations — not code. Every research PRD has mandatory human decision gates before any implementation can begin.

**Key difference from `/prd`:** The output of a research PRD is a set of research documents in `research/` and architecture specs in `architecture/`, not deployed features. Acceptance criteria measure document quality, source depth, and analytical rigor — not typechecks.

---

## When to Use

- Evaluating technology options for Hyperfactory architecture
- Competitive analysis (products, approaches, standards)
- Academic/industry research (UX patterns, manufacturing standards, protocols)
- Ontology/architecture pattern analysis
- Any effort where the deliverable is a **decision document**, not code

**Do NOT use for:**
- Feature development → use `/prd`
- Bug fixes → use `/prd` (bug investigation mode)
- Implementation tasks → use `/prd`

---

## The Job

1. Determine the **research domain** and scope
2. Ask 3-5 essential clarifying questions (with lettered options)
3. Generate a structured Research PRD
4. Create directory: `tasks/{effort-name}/`
5. Create subdirectory: `tasks/{effort-name}/decisions/`
6. Save PRD to `tasks/{effort-name}/prd.md`
7. Initialize empty `tasks/{effort-name}/progress.txt`

**Important:** Do NOT start researching. Just create the PRD and directory structure.

---

## Directory Structure

```
tasks/
├── ux-architecture-research/
│   ├── prd.md              # This research PRD
│   ├── prd.json            # Created by /ralph (research mode)
│   ├── progress.txt        # Ralph's iteration logs
│   ├── decisions/          # Decision gates requiring human input
│   │   ├── RS-010-DECIDE_visualization-engine.md
│   │   └── RS-020-DECIDE_app-architecture.md
│   └── sources/            # Source cache (optional, for offline reference)
│       ├── tulip-analysis.md
│       └── isa-101-summary.md
```

---

## Step 1: Determine Research Domain

Identify the research scope. Research efforts map to Hyperfactory's architecture layers:

```
Which area does this research cover?
  A. Layer 0 — Cloud Infrastructure
  B. Layer 1 — ZTNA / Security
  C. Layer 2 — UNS / Data Plane
  D. Layer 3 — Agents / AI
  E. Layer 4 — UI / UX / Visualization
  F. Cross-cutting (multiple layers)
  G. External (competitive analysis, standards, academic)
```

---

## Step 2: Clarifying Questions

Ask only critical questions. Focus on:

### Research Scope

```
1. What is the primary research question?
   A. Technology selection (which tool/framework/library?)
   B. Architecture pattern (how should components interact?)
   C. Competitive analysis (what do others do and why?)
   D. Standards research (ISA-101, ISA-95, OPC-UA, etc.)
   E. UX/design research (interaction patterns, accessibility, ergonomics)
   F. Feasibility evaluation (can X work for our constraints?)

2. What is the expected output?
   A. A single decided research document (one decision)
   B. Multiple related research documents (parallel decisions)
   C. A comprehensive landscape analysis (no immediate decision needed)
   D. Architecture specification (research feeds directly into spec)

3. How deep should the research go?
   A. Survey level — identify options, brief pros/cons (1-2 hours per topic)
   B. Analysis level — deep comparison, benchmarks, citations (4-8 hours per topic)
   C. Expert level — academic sources, standards docs, reference implementations (1-2 days per topic)

4. Are there known constraints that narrow the search?
   A. Must be open source (specify license: Apache 2.0, MIT, AGPL OK, etc.)
   B. Must integrate with specific existing component (name it)
   C. Must meet specific performance/scale requirements
   D. Must work in air-gapped environments
   E. No constraints — evaluate broadly

5. Who needs to review before decisions are made?
   A. Alex reviews all decisions (default)
   B. Alex reviews only major architectural decisions
   C. Agent can decide within documented constraints
```

---

## Step 3: Research PRD Structure

### Preamble

```markdown
# Research PRD: [Topic Name]

## Type
Research

## Overview
What we're researching, why, and what decisions will be made from the findings.

## Research Scope
- Primary question(s)
- Expected deliverables (list of research documents)
- Architecture files that will be created/updated upon completion
- Related existing research (link to research/index.md entries)

## Constraints
- License requirements
- Integration requirements
- Performance/scale requirements
- Air-gap compatibility
- Timeline

## Decision Authority
Who approves decisions at each gate:
- Survey findings: [Agent / Alex]
- Technology selection: [Agent / Alex]
- Architecture specification: [Alex always]
```

### Story Types

Research PRDs use three story types:

#### 1. Research Stories (RS-xxx)

Produce a research document. The deliverable is a markdown file in `research/{layer}/`.

```markdown
### RS-010: [Research Topic]
**Description:** Research [topic] to inform [decision].

**Phase:** 1 (Survey) | 2 (Deep Analysis) | 3 (Specification)

**Deliverable:** `research/{layer}/{topic-name}.md`

**Acceptance Criteria:**
- [ ] Document follows research template (Context, Constraints, Options, Comparison, Analysis)
- [ ] Minimum {N} sources cited with URLs (no "industry best practice" without citation)
- [ ] Each option evaluated against Hyperfactory's constraints (air-gap, licensing, scale)
- [ ] Comparison matrix with concrete criteria (not subjective ratings)
- [ ] Open questions identified for follow-up
- [ ] If agent lacks deep knowledge, explicitly states gaps and recommends specific readings
```

#### 2. Decision Gate Stories (RS-xxx-DECIDE)

Pause for human review. **Mandatory** before any architecture specification.

```markdown
### RS-010-DECIDE: [Decision Name]
**Description:** Human decision required on [topic] based on research findings.

**Type:** Decision Gate
**Blocked By:** [Research stories that feed this decision]
**Blocks:** [Specification stories or further research]

**Acceptance Criteria:**
- [ ] Options documented in `decisions/RS-010-DECIDE_{slug}.md`
- [ ] Agent recommendation included with confidence level and reasoning
- [ ] Trade-offs explicitly stated (not just pros/cons — what do we LOSE with each option?)
- [ ] Human has reviewed and selected an option
- [ ] Decision rationale recorded
```

#### 3. Specification Stories (RS-xxx-SPEC)

Produce or update an architecture document. Only runs after a decision gate is resolved.

```markdown
### RS-030-SPEC: [Specification Topic]
**Description:** Update architecture docs to reflect decided research.

**Phase:** 3 (Specification)
**Blocked By:** [Decision gate that approved this]

**Deliverable:** `architecture/{layer}/{file}.md`

**Acceptance Criteria:**
- [ ] Architecture doc is declarative (no rationale, no comparisons)
- [ ] Cross-references decided research document
- [ ] Follows ARCHITECTURE_STANDARD.md format
- [ ] tech-stack-overview.md maturity tracker updated if applicable
- [ ] Roadmap items extracted to roadmap/index.md
- [ ] Decided research file moved to research/{layer}/complete/
- [ ] research/index.md updated
```

### Phases

Research PRDs always have 3 phases:

```markdown
## Phases

### Phase 1: Survey
Broad landscape scan. Identify candidates, eliminate non-starters, map the option space.
Stories: RS-010 through RS-0x9

### Phase 2: Deep Analysis
Deep-dive on viable candidates. Benchmarks, reference implementations, expert sources.
Stories: RS-020 through RS-0x9, plus decision gates

### Phase 3: Specification
Convert decided research into architecture specs. Update all cross-references.
Stories: RS-030-SPEC through RS-0x9-SPEC
```

---

## Acceptance Criteria Standards

Research stories have fundamentally different quality criteria than code stories.

### Good research criteria (verifiable):
- "Cite minimum 5 primary sources (official docs, papers, product pages)"
- "Compare 3+ options using these criteria: licensing, real-time capability, air-gap support, learning curve"
- "Include at least one concrete example of each option in production use"
- "Document what we LOSE by choosing each option, not just what we gain"
- "If a claim cannot be verified, mark it as [UNVERIFIED] with suggested verification method"
- "Identify 2+ open questions that require deeper investigation or hands-on evaluation"

### Bad research criteria (vague):
- "Research is thorough"
- "Good analysis"
- "Options are compared"
- "Industry best practices documented"

### Always include as final criterion:
```
"Document follows research template structure"
```

For survey stories:
```
"Minimum {N} sources cited with URLs"
```

For deep analysis stories:
```
"Each option evaluated against Hyperfactory constraints (air-gap, licensing, scale, manufacturing context)"
```

For specification stories:
```
"Architecture doc is declarative — no rationale, no comparisons (link to research for those)"
```

---

## Source Quality Requirements

Research agents must cite sources. Quality tiers:

| Tier | Source Type | Examples | Minimum per story |
|------|-----------|----------|-------------------|
| **Primary** | Official docs, API references, source code | GitHub repos, product docs, RFC specs | 2+ |
| **Secondary** | Blog posts, tutorials, case studies | Engineering blogs, conference talks | 1+ |
| **Academic** | Papers, standards, textbooks | ISA-101, IEEE, ACM | When topic warrants |
| **Competitive** | Product demos, pricing pages, feature lists | Competitor websites, G2 reviews | For competitive analysis |

**Rules:**
- Every factual claim must have a source
- "Industry best practice" without a citation is not acceptable
- If a source is paywalled or unavailable, note it and cite what IS available
- Prefer primary sources over secondary
- Date all sources — technology moves fast

---

## Decision Gate File Template

**IMPORTANT:** Decision files go INSIDE the task directory, NOT at the repo root.
Create `tasks/{effort-name}/decisions/RS-010-DECIDE_{slug}.md`:

```markdown
# Decision: [Topic]
**Story:** RS-010-DECIDE
**Status:** PENDING
**Blocks:** [List of blocked stories]
**Research:** [Links to research documents that inform this decision]

---

## Context

[Summary of research findings. What did we learn? What surprised us?]

## Options

### Option A: [Name]
[Description — what this means for Hyperfactory specifically, not generic pros/cons]

**What we gain:** [Specific capabilities]
**What we lose:** [Specific trade-offs — be honest]
**Estimated effort:** [Rough scope]
**Risk:** [What could go wrong]

### Option B: [Name]
[Same structure]

## Agent Recommendation

**Recommended: Option [X]**

**Reasoning:** [Why this option best fits Hyperfactory's constraints]

**Confidence:** [HIGH/MEDIUM/LOW]
- HIGH: Clear winner based on research. Would be surprised if human disagrees.
- MEDIUM: Good option but trade-offs are real. Human input adds value.
- LOW: Options are close or agent lacks domain expertise. Human decision essential.

**What I'm unsure about:** [Honest statement of gaps in agent's analysis]

---

## Human Decision

> Review the research, then fill in this section.

**Selected Option:**
<!-- Enter: A, B, etc. -->

**Rationale:** (optional)
<!-- Why you chose this option -->

**Additional Constraints:** (optional)
<!-- Anything the agent should know for specification phase -->

**Modified Scope:** (optional)
<!-- If you want a hybrid or modified version of an option -->

---
*Generated by Research PRD • Human decision required to continue*
```

---

## Example: UX Architecture Research PRD

```markdown
# Research PRD: Hyperfactory User Experience Architecture

## Type
Research

## Overview
Research the complete user experience architecture for Hyperfactory's manufacturing
platform — the product that factory teams use daily. Covers application architecture,
visualization engine, UNS interaction model, role-based access, and MVP experience.

Broader scope includes: competitive analysis (Palantir, Tulip, Siemens, PTC),
manufacturing HMI standards (ISA-101), visualization technology (WebGPU, WASM),
the ontology question (UNS as ontology layer), and academic UX research for
industrial environments.

## Research Scope
- 5 decision areas (app architecture, visualization, UNS interaction, RBAC, MVP UX)
- 3 landscape analyses (competitive, standards, technology)
- Expected deliverables: 8 research documents, 5 decision gates, architecture updates
- Existing research: research/4-ui/user-experience-architecture.md (active, 5 decisions framed)

## Constraints
- Must work in air-gapped environments (AI features optional, not required)
- Must support real-time streaming (sub-second updates from UNS)
- Open source preferred (Apache 2.0, MIT); AGPL evaluated case-by-case
- Must feel native, not like a Grafana wrapper
- Design system (architecture/4-ui/design-system.md) defines aesthetic bar

## Decision Authority
- Survey findings: Agent decides which options to deep-dive
- Technology selection: Alex reviews via decision gate
- Architecture specification: Alex reviews via decision gate

## Phases

### Phase 1: Survey (Landscape Scan)
Broad research across all domains. Eliminate non-starters. Map option space.

### Phase 2: Deep Analysis
Deep-dive viable candidates. Competitive teardowns. Standards mapping.

### Phase 3: Specification
Architecture docs from decided research. Update system-context, 4-ui, tech-stack.

## Survey Stories (Phase 1)

### RS-010: Competitive Landscape Analysis
**Description:** Analyze manufacturing platform competitors.

**Phase:** 1
**Deliverable:** `research/4-ui/competitive-landscape.md`

**Acceptance Criteria:**
- [ ] Cover Palantir Foundry, Tulip, Siemens MindSphere, PTC ThingWorx, Sight Machine, Rockwell FactoryTalk
- [ ] For each: target market, pricing model, key differentiators, UX approach, visualization capabilities
- [ ] Identify patterns — what do ALL successful platforms have in common?
- [ ] Identify Hyperfactory's differentiation opportunity
- [ ] Minimum 12 sources cited
- [ ] Document follows research template

### RS-011: Manufacturing UX Standards & Academic Research
**Description:** Research ISA-101, HMI design standards, and academic UX literature for industrial interfaces.

**Phase:** 1
**Deliverable:** `research/4-ui/manufacturing-ux-standards.md`

**Acceptance Criteria:**
- [ ] ISA-101 HMI standard: key principles, color usage, alarm management, layout patterns
- [ ] ISA-95 as it relates to UI scope (enterprise→site→area→line→cell navigation)
- [ ] Academic research on factory floor display design (lighting, distance, touch targets)
- [ ] Kiosk/touchscreen design patterns for industrial environments
- [ ] Dark environment readability research
- [ ] Minimum 8 sources cited (including at least 2 academic/standards)
- [ ] Document follows research template

### RS-012: Visualization Technology Survey
**Description:** Survey visualization technologies for real-time manufacturing dashboards.

**Phase:** 1
**Deliverable:** `research/4-ui/visualization-technology-survey.md`

**Acceptance Criteria:**
- [ ] Canvas-based: D3.js, Konva, Fabric.js, PixiJS, Three.js
- [ ] Chart libraries: Recharts, Nivo, Victory, ECharts, Highcharts, Plotly
- [ ] WebGPU/WASM: current browser support, performance characteristics, maturity
- [ ] Real-time rendering: requestAnimationFrame patterns, WebSocket streaming, virtual DOM vs canvas
- [ ] Each option: license, bundle size, React integration, real-time capability, learning curve
- [ ] Minimum 10 sources cited
- [ ] Document follows research template

### RS-013: UNS Ontology Analysis — Palantir Foundry vs UNS
**Description:** Analyze whether UNS serves as Hyperfactory's ontology layer (like Palantir's Ontology).

**Phase:** 1
**Deliverable:** `research/4-ui/uns-ontology-analysis.md`

**Acceptance Criteria:**
- [ ] Palantir Ontology: what it is, how it structures data, how UIs bind to it
- [ ] UNS as ontology: ISA-95 hierarchy, topic semantics, metadata layer
- [ ] Gap analysis: what UNS provides that Ontology does, what it doesn't
- [ ] Implications for UI data binding, dashboard builder, AI understanding
- [ ] Minimum 6 sources cited
- [ ] Document follows research template

### RS-014: Low-Code/Dashboard Builder Platform Survey
**Description:** Survey open-source low-code and dashboard builder platforms.

**Phase:** 1
**Deliverable:** `research/4-ui/dashboard-builder-survey.md`

**Acceptance Criteria:**
- [ ] Cover: Apache Superset, Appsmith, ToolJet, Budibase, NocoDB, Evidence, Retool (as reference)
- [ ] For each: license, real-time support, customizability, embedding story, AI integration
- [ ] Evaluate "build vs embed vs fork" for each
- [ ] Manufacturing-specific gaps in each platform
- [ ] Minimum 10 sources cited
- [ ] Document follows research template

## Decision Gates (Phase 1→2 Transition)

### RS-010-DECIDE: Application Architecture
**Type:** Decision Gate
**Blocked By:** RS-010, RS-011, RS-013
**Blocks:** RS-020, RS-030-SPEC

Decides: Two apps vs three apps vs unified with admin panel.

### RS-012-DECIDE: Visualization Strategy
**Type:** Decision Gate
**Blocked By:** RS-012, RS-014
**Blocks:** RS-021, RS-031-SPEC

Decides: Custom canvas vs component library vs embedded OSS vs hybrid.

## Deep Analysis Stories (Phase 2)

### RS-020: Deep Dive — [Selected App Architecture]
**Phase:** 2
**Blocked By:** RS-010-DECIDE
*Created after decision gate resolves*

### RS-021: Deep Dive — [Selected Visualization Approach]
**Phase:** 2
**Blocked By:** RS-012-DECIDE
*Created after decision gate resolves*

## Specification Stories (Phase 3)

### RS-030-SPEC: Update Application Architecture
**Phase:** 3
**Blocked By:** RS-020
**Deliverable:** `architecture/4-ui/overview.md` (update)

### RS-031-SPEC: Create Visualization Engine Spec
**Phase:** 3
**Blocked By:** RS-021
**Deliverable:** `architecture/4-ui/visualization-engine.md` (new)

### RS-999: Research Completion Validation
**Phase:** 3
**Blocked By:** All Phase 3 stories

**Acceptance Criteria:**
- [ ] All research documents in research/4-ui/ with decided status
- [ ] All architecture docs updated (declarative, no rationale)
- [ ] All cross-references valid (grep for broken links)
- [ ] Decided research moved to research/4-ui/complete/
- [ ] research/index.md updated
- [ ] Roadmap items extracted
- [ ] tech-stack-overview.md maturity tracker updated
```

---

## Conversion to prd.json

When converting with `/ralph`, use these research-specific rules:

1. **type:** Set to `"research"`
2. **Story IDs:** Use `RS-` prefix instead of `US-`
3. **Acceptance criteria:** No "Typecheck passes" — use document quality criteria
4. **canSpawnStories:** Set on survey stories that feed decision gates
5. **Decision gates:** Same `decisionConfig` as investigation PRDs
6. **Phase 3 stories:** Always `blockedBy` their decision gate

### prd.json Schema Additions for Research

```json
{
  "schemaVersion": "2.2",
  "type": "research",
  "researchConfig": {
    "outputDir": "research/{layer}/",
    "architectureTargets": ["architecture/{layer}/{file}.md"],
    "sourceRequirements": {
      "minimumPerStory": 5,
      "requirePrimarySources": true,
      "requireURLs": true
    }
  }
}
```

---

## Ralph Research Mode

When Ralph executes a research PRD, each iteration:

1. **Reads** the assigned research story
2. **Searches** the web for sources (WebSearch, WebFetch)
3. **Analyzes** findings against Hyperfactory's constraints
4. **Writes** the research document to the specified deliverable path
5. **Cites** all sources with URLs
6. **Registers** the research in `research/index.md` if new
7. **Creates** decision gate files when reaching a decision point
8. **Stops** at decision gates and waits for human input

**Critical difference from code Ralph:** Research Ralph does NOT:
- Run typechecks
- Run tests
- Modify source code
- Verify in browser

Research Ralph DOES:
- Use WebSearch and WebFetch extensively
- Read competitor documentation and product pages
- Read academic papers and standards documents
- Produce structured markdown documents
- Create comparison matrices with cited data
- Flag knowledge gaps honestly
- Recommend specific further reading when uncertain

---

## Checklist

Before saving the Research PRD:

- [ ] Type is "Research" (not Feature or Investigation)
- [ ] All stories produce documents, not code
- [ ] Every research story has minimum source citation requirement
- [ ] Decision gates exist between survey and deep analysis phases
- [ ] Decision gates exist between deep analysis and specification phases
- [ ] Specification stories update architecture docs (declarative, no rationale)
- [ ] No "Typecheck passes" criteria (use document quality criteria instead)
- [ ] Anti-slop criteria: no "industry best practice" without citation, no vague analysis
- [ ] Source quality requirements specified (primary, secondary, academic tiers)
- [ ] Decision authority documented (who approves at each gate)
- [ ] Created `tasks/{effort-name}/` directory
- [ ] Created `tasks/{effort-name}/decisions/` directory
- [ ] Saved PRD to `tasks/{effort-name}/prd.md`
- [ ] Initialized `tasks/{effort-name}/progress.txt`
