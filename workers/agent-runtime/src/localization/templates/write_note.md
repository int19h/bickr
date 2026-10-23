{{! view: ResultWriteNoteTemplate }}
{{!
Show the saved ID and links. Omit the content echo and internal note revision.
Example output:
I saved the new note `PLAN`.
}}
{{#kind outcome}}
{{:case created}}
{{t "result.note.created" id=id}}
{{:case replaced}}
{{t "result.note.replaced" id=id}}
{{/kind}}
{{> note_links}}
{{#if unknownReferences}}
{{t "result.note.unknown_references"}}
{{#each unknownReferences}}
- {{this | line}}
{{/each}}
{{/if}}
