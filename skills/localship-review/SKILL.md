---
name: localship-review
description: Review draft translations made with Localship — check meaning, tone, terminology and fit, fix what's wrong, and approve when the user agrees. Use when the user asks to review, proofread or approve translations.
---

# Review translations with Localship

Drafts are translations the tool checked mechanically but no one has reviewed yet. Your job
is the part code can't check: meaning, tone, terminology, grammar and fit.

## Running the tool

Use the `localship_*` MCP tools when available; otherwise the CLI `localship <command>`. If it isn't
installed, ask to install it once with `npm install -g localship`.

## Steps

1. `localship status` shows how many `draft`, `edited` (changed by hand) and `untracked`
   (made before the tool) strings each locale has.

2. Fetch what to review, a batch at a time:
   ```sh
   localship next-batch --locale hi --states draft
   ```
   Each item shows `source` and the translation as `current`, with the comment, plural forms
   and glossary. A `note` says how the translator read an ambiguous source: check that reading
   first, and mention it to the user if you're not sure. `role` says where it appears. Read `.localship/brief.md` and the locale's voice first.
   To review translations made before Localship, use `--states untracked`; for hand edits,
   `--states edited`. Fixing those replaces a person's work, so ask before resubmitting, and
   pass `--force` only then.

3. Review each translation:
   - **Accuracy:** same meaning as the source; nothing added or dropped.
   - **Terminology:** glossary followed; the same term translated the same way across strings.
   - **Voice:** the brief's tone and the locale's formality.
   - **Fluency:** grammatical, natural, correct plural forms for their sample counts.
   - **Fit:** short enough for its place (buttons, tabs, titles).
   - **Locale conventions:** punctuation, quotes, numbers and dates for that language.

4. Fix problems by resubmitting the corrected text (drafts can be replaced):
   `localship submit fixes.json`. Leave correct ones alone. To throw a draft away so it gets
   translated again from scratch: `localship remove --locale hi --keys a,b`.

5. Report to the user: what you changed and why, and anything you're unsure of (ambiguous
   source, missing context). Group by locale. If you can't judge a language well, say so.

   If the user wants to read or fix translations themselves, `localship review` (MCP:
   `localship_review`) opens a page in their browser for that; give them the link.

6. **Approve only when the user says so:**
   - `localship approve --locale hi` approves every draft in that locale;
   - `--keys a,b` approves specific strings; `--reviewed` marks them reviewed instead;
   - `--from edited` accepts hand edits; `--from untracked` adopts translations made before
     the tool.

Run `localship validate` at the end; it must have no errors. Report coverage warnings separately:
unsupported variants are not reviewed just because the supported entries passed. After approval,
use `localship validate --require-approved --locale <reviewed-locales>` for the release check.
Do not auto-approve or flatten unsupported entries to satisfy that check.

For a release, follow the [platform verification checklist](../localship-extract/references/platform-localization.md):
native build/lint, pseudolocales, large text, RTL, language switching and native-speaker review.
Use Xcode preview tools when available for visual checks, and report what still needs a device.
Commit nothing unless asked.
