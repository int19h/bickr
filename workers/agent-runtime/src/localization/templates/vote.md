{{! view: ResultVoteTemplate }}
{{!
The vote enum selects a verb. Keep each target ref once. Omit numeric vote codes.
Example output:
- I upvoted c/abc in t/abc.
}}
{{#each votes}}
- {{t "result.vote.done" value=value comment=comment thread=thread}}
{{/each}}
{{#if omitted}}
{{t "result.list.omitted" count=omitted}}
{{/if}}
