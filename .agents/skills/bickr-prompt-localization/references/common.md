# Shared translation rules

Preserve every condition, prohibition, permission, limit, dependency, actor, and exception from the English source. Preserve uncertainty when the source contains uncertainty. Do not turn a recommendation into a requirement during translation. The English writing skill governs new English prose, but translation must preserve the original force.

Do not infer the participant's gender from a name or language. Use grammatical formulations that avoid an unknown speaker gender where possible. Preserve the source tense, perspective, and action when doing so. A gender-neutral paraphrase cannot change completed actions into planned actions.

Use ordinary, neutral technical prose. Put each action in its own sentence. State the condition before its action when that order is natural and clear. Use the same term for the same concept. Name the actor when a pronoun or omitted subject can cause ambiguity. Avoid humor, praise, rhetorical questions, literary language, regional slang, and decorative emphasis. Use standard loanwords when readers know them better than a forced new term.

Protect tool names, argument names, enum values, JSON examples, placeholders, handles, refs, PLAN, units, and code. Translate explanatory text inside examples only when it is explicitly marked as translatable. Do not change escapes or protocol delimiters. Do not translate inserted participant content, stored note titles, persona text, or provider diagnostics.

Review meaning separately from fluency. Use the independent reviewers and translation models named for the current task. Each translator starts from the same frozen English source without reading other drafts. Record the source hash, final text, review decisions, and unresolved uncertainty. The lead translator resolves remaining disagreement. Mark Irish terminology uncertainty explicitly.

Sentence length follows the language's natural units. Do not impose English word counts on languages without word spaces. Use grammatical complete sentences where required, and conventional concise instructions where natural. Prefer direct verbs over chains of abstract nouns. Number agreement and inflection belong in whole message variants, not English-style suffix interpolation. Use the target language's ordinary punctuation outside protected tokens and JSON.


## Voices

The participant speaks in the first person in assistant narration and memory. Preserve the source tense and aspect. Avoid inferring an unknown gender. The Bickr app speaks in user-role environment reports. Direct instructions address the participant in the register defined for the language. Tool results describe outcomes and retain inserted content unchanged.

## Formatting

In the current Workers runtime, Intl.ListFormat and Intl.RelativeTimeFormat fall back to English for Esperanto, Belarusian, and Irish. Use explicit catalog patterns for those languages. Intl.PluralRules supports their native count categories. Do not accept an English fallback in Bickr catalog output. Use ASCII digits in all catalog text.

## Protected syntax and examples

Keep MYSELF, META:, …, ‼️, Bickr, BCP 47 tags, and the ref prefixes u/, f/, t/, c/, and w/ unchanged.
Keep Markdown, TeX, Mermaid, and SVG keywords unchanged.
Keep the English transcript labels Action:, Result:, Input:, and New thought: unchanged wherever the source protects them.
The catalog also defines four translated transcript labels for detection and guidance.
Translate those entries, and keep their names separate from the protected English labels.

Do not inflect, mutate, transliterate, or attach letters to a protected token.
Keep ASCII quotes and backticks around protected tokens and inside JSON.
Use target-language quotation marks only around translated prose.
A placeholder can move within a sentence, but its name cannot change.
Do not modify an inserted stored value. Ordinary particles that do not depend on the value's pronunciation can follow a placeholder. If a suffix depends on unknown pronunciation or inflection, use a head noun outside the placeholder.
If grammar needs an unknown inflection, use a head noun, apposition, or a colon outside the value.

The frozen English unit states which example prose is translatable.
Translate marked sample text, and set its lang to the catalog content tag.
For Chinese, that tag is zh-Hans.
Keep examples that illustrate a specific tag unchanged.
This includes {"lang":"ja","text":"将軍家"} and {"lang":"en","text":"my text"}.

If a first-person predicate marks gender, choose a neutral form that preserves the tense, action, and actor.
The translation must not infer gender from a name, persona language, or instruction register.
Make sure that list and relative-time tests cover Esperanto, Belarusian, and Irish without English fallback words.

Tool and schema descriptions keep the source perspective, whether it is first-person participant speech or neutral description. Keep their description register consistent. Avoid gendered predicates about an unknown speaker in these descriptions.


## Count variants

A plural category selects grammar for a group of numbers. It does not name a single number.
Keep the count placeholder visible in every variant. Never replace it with the word for one or two.
Make each variant grammatical for every supported integer in its category.
Inspect the locale rules before translation. Make sure that sample counts cover 0, 1, 2, 3, 6, 7, 10, 11, 21, 100, 101, and 1000000.
Use additional counts when the locale distinguishes their grammar.
French and Hindi assign 0 to one. Russian, Ukrainian, and Belarusian assign 21 and 101 to one.
Arabic and Irish need more categories than English. Japanese, Korean, Chinese, Indonesian, and Vietnamese use other for every count.
A category alone does not specify grammatical case, agreement, or numeral wording.
Choose a whole sentence that fits its noun and syntax. If one category covers different inflections, use a neutral count label.
Keep complete conditions and prohibitions in each variant. Do not assemble sentences from translated suffixes.
