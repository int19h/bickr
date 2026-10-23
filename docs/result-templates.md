# Markdown result templates

The localization generator compiles result templates into TypeScript functions before the app builds.
Each function reads named fields from a typed view and joins strings.
The runtime does not parse Markdown templates or inserted text.

## Files and generation

Put shared templates in `workers/agent-runtime/src/localization/templates/`.
Put reusable partials, which are small templates, in its `partials/` directory.
Use lowercase filenames with underscores or hyphens and the `.md` extension.
All languages use the same templates.
Put result messages in `results.yaml` in each language directory.
Declare their keys and parameters in `localization/messages.ts`.
The result catalogs hold the messages for the shared templates.

Start every template and partial with its view type:

```mustache
{{! view: ThreadReadView }}
```

Export the type from `localization/result-template-views.ts`.
Use `npm run localization:generate` to create the render functions.
The generated module is `src/.generated/localization/result-templates.ts` in the agent runtime package.
Do not edit generated files.
Use `npm run localization:check` to detect stale generated files.
Vite and the development command wrappers watch Markdown templates and catalog sources.

The generator reports the source file and line for syntax errors and catalog argument errors.
It emits typed field access without loading the runtime type graph.
This keeps generation fast when a development server reloads catalogs.

The normal TypeScript build rejects missing fields, wrong filter types, and incomplete switches.
Run `npm run build` from the repository root for these type checks.
The build uses the complete project, including its ambient declarations, which define types without runtime code.
Each generated line records its template location in a comment.
The build maps diagnostics on those lines back to the template file and line.
Errors in other project files retain their own locations.

Generation and `localization:check` do not run a second TypeScript program.
The compiler pairs each kind label with its value.
This keeps field narrowing in generated TypeScript without asking TypeScript to inspect views during generation.

## Words and values

Keep Markdown structure in templates.
Put every word in a catalog message or a view field.
Write whole sentences as catalog messages so that each language can choose its word order.

```mustache
### {{ref}}
{{t "result.comment.reply" author=author when=when parent=parent}}
```

A catalog call must supply exactly the declared parameter names.
Every parameter uses its inline form, a type-specific text representation.
A catalog key must exist before a template can use it.
Inserted text such as `{{t "x"}}` stays literal text.

`InlineValue<K>` wraps a value with a `kind` that selects its renderer.
The registry supports `threadRef`, `commentRef`, `profileRef`, `forumRef`, `noteId`, `cursor`, `count`, `score`, `timestamp`, and `author`.
Refs are bare text.
A thread ref can carry a title in localized quotation marks.
An author can carry a display name before the profile ref.
The view builder decides whether to include those optional fields.
Note IDs and cursors use code spans.
Counts use the instruction language number format.
Scores include a plus sign above zero, a minus sign below zero, or `0`.
A timestamp holds the formatter output from the time subsystem.

`RenderContext` supplies the instruction catalog, quotation marks, and inline renderers.
Build its quotation marks from catalog entries that return `InstructionText`.
`createInlineRenderers` creates the default registry from that context.
A plural parameter retains its numeric value for grammar and its inline text for output.

## Filters

`FreeText` brands authored text, which means that plain inline insertion cannot accept it.
Choose a filter for its output position:

```mustache
{{body | quote}}
{{bio | cell}}
{{title | line}}
{{noteId | code}}
{{message | text}}
{{content | raw_last}}
```

The `quote` filter prefixes each nonempty line with `> ` and each empty line with `>`.
This contains foreign Markdown, including fake headings and rules.
The `cell` filter accepts free text or an inline value.
For an inline value, it first renders the inline form.
It then escapes backslashes and vertical bars, replaces line breaks with spaces, and trims edge whitespace.
Use `{{ref | cell}}` for a thread ref with a title inside a table.
Use `{{author | cell}}` for an author with a display name inside a table.
The `line` filter replaces line breaks with spaces and surrounds the text with the instruction language quotation marks.
The `code` filter chooses a backtick fence longer than every backtick run in the value.
It adds padding when CommonMark needs it and replaces line breaks with spaces.
An empty value produces no code span.
The `text` filter accepts only `InstructionText` from Bickr catalogs.
The `raw_last` filter inserts the reader's own note content without formatting.

Nothing can follow `raw_last`, including whitespace or output after an enclosing block or partial.
The compiler removes one final file line break before parsing.
A template can end with `{{content | raw_last}}` followed by the normal final newline.
Additional trailing whitespace still counts as output.
Both branches of a terminal condition can end with `raw_last`.
A loop cannot contain `raw_last`, because a later iteration can add output.

## Conditions and loops

Conditions accept optional fields, booleans, numbers, and lists.
Zero and an empty list are false.
A nonzero number and a nonempty list are true.

```mustache
{{#if parent}}
{{parent}}
{{else if forum}}
{{forum}}
{{else}}
{{t "result.comment.opening" author=author when=when}}
{{/if}}
{{#unless empty}}
{{#each comments}}
{{#unless @first}}
---
{{/unless}}
{{this.ref}}
{{/each}}
{{/unless}}
```

Inside a loop, bare paths read fields of the current item.
`this` names that item.
`@first` is true only on its first iteration.
A nested loop gets its own item and first-iteration flag.
Conditions retain TypeScript field narrowing for optional values.

## Kind switches

A kind switch handles a string union or the `kind` field of an object union.
A union is a type with a fixed set of alternatives.

```mustache
{{#kind bodyState}}
{{:case shown}}
{{body | quote}}
{{:case seen_earlier}}
{{t "result.comment.seen_earlier"}}
{{/kind}}
```

Each alternative needs a case.
The generated switch calls `assertNever` in its default branch.
TypeScript rejects that call when an alternative remains unhandled.
An empty case renders nothing.
Use several names in one tag for a shared body, for example `{{:case search view}}`.
A name cannot appear twice in a switch, including within the same tag.

## Partials

A partial declares its own view type.
Pass the current value or a named field:

```mustache
{{> comment}}
{{> comment openingPost}}
```

The compiler requires a file named `partials/comment.md`.
It makes sure that the passed value matches the partial type.
Recursive partials are compile errors.
A partial with `raw_last` must also be last in its caller.

## Comments and blank lines

Comments start with `{{!` and end with `}}`.
They can span lines.
A comment cannot contain `}}` or another template delimiter.

A line with only a comment or a block tag disappears with its newline.
This rule also applies to a standalone partial tag.
Blank lines around that line remain.
Inline comments disappear but preserve the surrounding text and newline.
A value or catalog call on its own line keeps its newline unless it is the final file line break.
Use output tests to make sure that spacing reads as intended.

## Select messages

A select message chooses a complete sentence from a fixed string union.
Declare `kind: 'select'`, `parameters`, `select`, and `variants` in the message definition.
The `select` field names the parameter that chooses the variant.
Every language must provide exactly the declared variants.

```typescript
{
  kind: 'select',
  parameters: ['actor', 'ref'],
  select: 'actor',
  variants: ['self', 'other'],
}
```

```yaml
result.posted:
  self: |-
    I posted {{ref}}.
  other: |-
    {{actor}} posted {{ref}}.
```

An author value carries `person: 'self' | 'other'` in its payload.
For a select parameter, it supplies that person and its inline text.
The selected sentence can omit the selector placeholder, as the self sentence does above.
Every other parameter must appear in each variant.
A string union can select `up`, `down`, or `cleared` in the same way.
A message can use plural or select grammar, but cannot combine them.
Report a need for both forms before changing the language.
