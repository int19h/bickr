{{! view: ResultReadNoteTemplate }}
{{!
The note ID stays in a code span. Keep note content raw and last so that the reader can copy it.
Example output:
## Note `PLAN`

My plan.
}}
## {{t "result.note.heading" id=id}}
{{> note_links}}

{{content | raw_last}}
