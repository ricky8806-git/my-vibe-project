# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

This directory (`My_Claude`) is a personal Claude Code workspace — not an application codebase. It serves as the root working directory for Claude Code sessions and contains personal automation projects and skills.

## Environment

- Platform: Windows 11, running Claude Code via bash shell (Unix syntax)
- Permissions are pre-configured in `.claude/settings.local.json`
- `GEMINI_API_KEY` is available as an env var (set in settings.local.json)

## Active Projects

### Package Tracker Dashboard (`package-tracker-dashboard/`)
A Google Apps Script web app that scans Gmail for package/shipping emails and displays a live tracking dashboard.

- **`Code.gs`** — server-side: Gmail search (6 queries, 14-day lookback), keyword-based classification, deduplication. No API key required.
- **`Index.html`** — frontend: email auto-fill, scan button, 3-section dashboard (Pending Deliveries / Pending Returns / Recently Completed).
- **Deployed at:** Google Apps Script (script.google.com). Every code change requires a **new deployment** — reusing the existing URL does not pick up changes.
- **Key constraint:** `after:DATE` in Gmail queries must wrap multi-sender `OR` groups in parentheses, otherwise the date filter only applies to the last term.

### Daily Package Tracker (Remote Trigger)
A stateless scheduled agent running in Anthropic's cloud.

- **Trigger ID:** `trig_011mmDZ2W1tWRKT281puXkwf`
- **Schedule:** `3 16 * * *` (9:03 AM PDT). Update to `3 17 * * *` in November for PST, back to `3 16 * * *` in March.
- Scans `ricky8806@gmail.com` via Gmail MCP and sends an HTML summary email daily.
- Manage at: https://claude.ai/code/scheduled/trig_011mmDZ2W1tWRKT281puXkwf

## Skills

Skills live in `.claude/skills/` and are invoked automatically when relevant.

### `pptx` skill
For any `.pptx` file operation. Key commands:
```bash
python -m markitdown presentation.pptx          # extract text
python scripts/thumbnail.py presentation.pptx   # visual overview
python scripts/office/unpack.py file.pptx out/  # raw XML editing
python scripts/office/soffice.py --headless --convert-to pdf file.pptx  # to PDF
pdftoppm -jpeg -r 150 file.pdf slide            # PDF to images for visual QA
```
Always run a visual QA pass using a subagent after generating slides. Read `.claude/skills/pptx/SKILL.md` for full workflow.

### `nano-banana` skill
For all image generation requests. Uses Gemini CLI:
```bash
gemini --yolo "/generate 'prompt'"   # text-to-image
gemini --yolo "/edit file.png 'instruction'"
gemini --yolo "/icon 'description'"
gemini --yolo "/diagram 'description'"
```
Output saved to `./nanobanana-output/`. Always use `--yolo` flag.

### `schedule` skill
For creating/updating/listing/running remote Claude triggers via `RemoteTrigger` tool.

## MCP Connectors (Available in Remote Triggers)

- **Gmail** — connector_uuid: `4451e87f-8124-4e77-8140-3c687328970d`
- **Google Calendar** — connector_uuid: `849f3800-ccd5-4d7a-ba82-71970ca1bfd0`

## Sending Gmail Drafts

No `gmail_send_draft` MCP tool exists. To send a draft, use Playwright browser MCP:
navigate to `https://mail.google.com/mail/u/0/#drafts`, open the draft, click the Send button ref.
