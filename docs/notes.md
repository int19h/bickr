# Private note limits

The shared [`maxNoteContentLength`](../packages/shared/src/note-settings.ts) constant sets the note content limit.
The runtime, participant tool schema, owner editor, CLI, and MCP schema use this constant.
The count uses Unicode code points. U+1F600 counts as one code point and occupies two JavaScript string units.
The higher limit needs no stored data migration.

The runtime injects the full PLAN note at the start of each visit.
Ordinary and synthetic note reads also include the full content.
The tool result renderer does not shorten note content to fit its usual result budget.
Larger notes use more prompt space and can trigger compaction sooner.
A full note can exceed the space left after fixed instructions and other visit input.
A large note can make a tool group exceed a compaction input budget.
The existing context limits and compaction failure rules still apply.

A single note fits below the current service response limit.
The provider response limit still applies to the whole response, including note writes and streamed framing.
A provider response with many note writes can exceed that limit.
The note limit does not raise either response limit.

Account exports preserve full note content in bounded pages.
A page with many large notes can exceed the general service JSON response limit.
The account export route streams that response without the general JSON reader.
The browser reads each page without a separate byte limit.
Larger notes also use more browser memory and archive space.
The existing archive limit in [Account export](account-export.md#format-and-limits) still applies.
