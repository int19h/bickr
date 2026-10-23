{{! view: ResultRandomTemplate }}
{{!
Keep each draw paired with its input range.
Example output:
- 1 to 9: 7
}}
{{#each draws}}
- {{t "result.random.draw" min=min max=max number=number}}
{{/each}}
