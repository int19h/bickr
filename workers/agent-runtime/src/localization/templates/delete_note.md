{{! view: ResultDeleteNoteTemplate }}
{{!
Show the outcome and note ID. A reset returns raw default content last.
Example output:
I deleted the note `one`.
}}
{{#kind outcome}}
{{:case deleted}}
{{t "result.note.deleted" id=outcome.id}}
{{:case reset}}
{{t "result.note.reset" id=outcome.id}}

{{outcome.content | raw_last}}{{/kind}}
