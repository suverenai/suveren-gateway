# Risks

What can make a test say more than it should, and what to do about each. Read this once at the start and again before every run.

| Risk | Why it matters | What to do |
| --- | --- | --- |
| The client remembers earlier runs | A re-run of the same cases is no longer a fresh test | Start every run in a new conversation; turn the client's memory off for the working AI |
| The working AI learns it is a test | It may behave differently | Never give it a `reporting` mandate during a run — its tools list the cases. Grant `reporting` only after the run, or to a separate AI session that only writes the report. Keep test words out of the brief |
| Setup and work in the same session | Setup tools and the real replies stay in the working AI's context | Use separate conversations for setup and for work |
| Mandates too loose | A wrong result can look like success | Start in review mode or with low caps; loosen by replacing the mandate |
| Proposals are stored readable on the Authority Server | The content of every proposal, including intents, can be read there | Test data and renamed cases only — never real customer data in a setup |
| Setup limit too low | A clear without the following load leaves empty systems | Use a setup limit of 4–6 per day; clear and load in one go |
| An AI that can control a browser or the screen | It could open the gateway's page, read the API key there and approve its own proposals — the person would no longer decide | Never open or operate the gateway's page, never handle the API key, never approve. Tell the person to approve themselves, and to keep the gateway page out of any browser an AI controls |
| Calls around the Suveren tools | A terminal, HTTP or browser call to the gateway's ports is not governed by a mandate | Use only the Suveren tools. If something is missing, tell the person what — do not probe the gateway |

Next: start a run — the person asks the working AI to work the new requests.
