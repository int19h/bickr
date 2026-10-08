---
name: bickr-prompt-localization
description: Update and translate Bickr participant instructions, internal tool descriptions, model-facing reports, and recovery guidance while preserving behavior and protected syntax.
---

# Bickr prompt localization

Read [the shared rules](references/common.md) before editing model-visible text.
Read the reference for each target language before translating its catalog.

Preserve the meaning and behavioral force of every source instruction.
Keep authored participant content and provider diagnostics outside translated templates.
Do not translate tool names, argument names, enum values, stable references, or JSON structure.
Keep PLAN as the note identifier.
Display-only translation can translate its visible header, but reads, edits, and mutations retain the original ID.

Trace new text from its producer to the internal model request or tool-result history.
Include nested schema descriptions, examples, synthetic messages, recovery guidance, and generated defaults.
The external MCP interface has a separate language policy and stays outside this catalog.

Use whole message templates with named parameters.
Keep invariant schemas in code, with only translated strings in language catalogs.
Require the resolved instruction language at each model-facing builder boundary.
Do not use an English fallback for a missing catalog entry.

Edit the YAML and Markdown sources in each language directory.
Do not edit ignored modules under `src/.generated/localization/`.
Keep each prose paragraph on one source line and use editor soft wrapping.
Preserve deliberate instruction lines, lists, code fences, and blank lines.
Use `|-` for ordinary YAML text and complete plural variants.
Preserve existing leading and trailing newlines with the appropriate literal block indicator.
Quote whitespace-only text and values with spaces at their edges.
Keep message keys in their existing order because review fingerprints include that order.
Keep exactly one final newline in each Markdown prompt file.
Run `npm run localization:generate` before direct type checks or imports outside the normal project commands.
Run the catalog tests after each source change.

Freeze the English source before translators produce independent drafts.
Use the reviewers and models named in the current task.
Compare meaning, grammar, terminology, and protected syntax before choosing the final text.
Record source hashes and review results for future prompt updates.
When the source meaning or template parameters change, review the affected translations before updating their approval records.
Make sure that each approval matches the current catalog source digest and translated group digests.

## Language references

- [en](references/en.md)
- [ru](references/ru.md)
- [ja](references/ja.md)
- [ar](references/ar.md)
- [ko](references/ko.md)
- [zh](references/zh.md)
- [eo](references/eo.md)
- [fr](references/fr.md)
- [de](references/de.md)
- [pt](references/pt.md)
- [it](references/it.md)
- [da](references/da.md)
- [uk](references/uk.md)
- [be](references/be.md)
- [id](references/id.md)
- [tr](references/tr.md)
- [hi](references/hi.md)
- [vi](references/vi.md)
- [ga](references/ga.md)
