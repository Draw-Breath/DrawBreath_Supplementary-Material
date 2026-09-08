# DrawBreath Supplementary Materials

This archive contains the supplementary materials for **DrawBreath**, a child–AI creative drawing system that regulates AI participation through **Stay**, **Observe**, and **Withdraw** judgments, with interruptible withdrawal and child-initiated re-entry.

## Contents

```text
DrawBreath_Supplementary Material/
├── DrawBreath_APP/                    # DrawBreath source code
│   └── drawing/
│       ├── src/server/                # Backend and AI participation logic
│       ├── src/web/                   # Frontend
│       ├── migrations/                # Database migrations
│       ├── tests/                     # Automated tests
│       ├── .env.example
│       ├── Dockerfile
│       └── docker-compose.yml
│
└── DrawBreath_Data/
    ├── DrawBreath_Experimental Data.xlsx
    ├── DrawBreath_Questionnaire Data.xlsx
    └── DrawBreath_Drawing Process Data/
```

### Application

The main implementation is under `DrawBreath_APP/drawing/`. The system uses a React/Vite frontend, an Express backend, and PostgreSQL. The most relevant implementation files are in `src/server/` and `src/web/`.

For a quick local setup:

```bash
cd DrawBreath_APP/drawing
cp .env.example .env
# Add the required database, JWT, and OpenAI-compatible API settings to .env
docker compose up --build
```

The application is then available at:

```text
http://localhost:3300
```

A valid OpenAI-compatible API key is required to reproduce the AI-assisted behavior used by the system.

### Study Data

- **`DrawBreath_Experimental Data.xlsx`** contains the processed study records and audit tables for the 65-participant analysis cohort, including drawing operations, interaction events, AI participation judgments, withdrawal events, and related timing information.
- **`DrawBreath_Questionnaire Data.xlsx`** contains the post-task questionnaire responses used in the paper.
- **`DrawBreath_Drawing Process Data/`** contains time-ordered drawing snapshots and final drawings for inspecting participants' visual creative trajectories.

The Excel workbooks should be treated as the authoritative source for the analyzed cohort and event records; folder counts alone should not be used to reconstruct the sample.

## Notes

The materials are provided for scholarly review and reproducibility. They include participant-level interaction traces and children's drawings. Please do not attempt to re-identify participants.

For the study design, filtering rules, variable definitions, and analysis procedures, please refer to the accompanying paper.
