import type { Plugin } from "unified";
import type { Root } from "mdast";
import { math } from "micromark-extension-math";
import { mathFromMarkdown } from "mdast-util-math";
import { markdownLineEnding } from "micromark-util-character";
import type { Construct, State, Tokenizer, TokenizeContext } from "micromark-util-types";

// GitHub protects inline TeX with $`...`$. Keep inner dollar signs and Markdown
// opaque at the lexer boundary, where escapes and code spans still have meaning.
// Once a protected opener reaches EOF, later openers in the same text stream
// cannot find a close either. Cache that fact weakly to avoid quadratic retries.
const noProtectedClose = new WeakSet<TokenizeContext>();
const githubInline: Construct = {
	name: "githubMath",
	previous(code) { return code !== 36 || this.events.at(-1)?.[1].type === "characterEscape"; },
	tokenize(effects, ok, nok) {
		const context = this;
		let protectedForm = false;
		let escaped = false;
		let hasData = false;
		return start;
		function start(code: number | null): State | undefined {
			effects.enter("mathText"); effects.enter("mathTextSequence"); effects.consume(code); return opening;
		}
		function opening(code: number | null): State | undefined {
			if (code === 36 || code === null) return nok(code);
			if (code === 96 && noProtectedClose.has(context)) return nok(code);
			if (code === 96) { protectedForm = true; effects.consume(code); return beginData; }
			return beginData(code);
		}
		function beginData(code: number | null): State | undefined {
			effects.exit("mathTextSequence"); effects.enter("mathTextData"); return data(code);
		}
		function data(code: number | null): State | undefined {
			if (code === null) { if (protectedForm) noProtectedClose.add(context); return nok(code); }
			if (hasData && !escaped && code === (protectedForm ? 96 : 36)) return effects.check({ tokenize: close }, finish, consume)(code);
			return consume(code);
		}
		function consume(code: number | null): State | undefined {
			if (code === null) return nok(code);
			effects.consume(code); hasData = true; escaped = !escaped && code === 92; return data;
		}
		function finish(code: number | null): State | undefined {
			effects.exit("mathTextData"); effects.enter("mathTextSequence"); effects.consume(code);
			return protectedForm ? dollar : end;
		}
		function dollar(code: number | null): State | undefined { effects.consume(code); return end; }
		function end(code: number | null): State | undefined { effects.exit("mathTextSequence"); effects.exit("mathText"); return ok(code); }
		function close(checkEffects: Parameters<Tokenizer>[0], checkOk: State, checkNok: State): State {
			return (code) => {
				checkEffects.enter("mathTextSequence"); checkEffects.consume(code); checkEffects.exit("mathTextSequence");
				return protectedForm ? (next) => next === 36 ? checkOk(next) : checkNok(next) : checkOk;
			};
		}
	},
};

export const remarkBickrMath: Plugin<[], Root> = function () {
	const syntax = math({ singleDollarTextMath: false });
	const flow = syntax.flow?.[36];
	if (!flow || Array.isArray(flow)) throw new Error("Expected one math flow construct");
	const tokenizeFlow = flow.tokenize;
	// The upstream flow parser treats opening-line text as metadata. GitHub also
	// accepts $$formula$$ on one line, which must instead reach its text parser.
	flow.tokenize = function (effects, ok, nok) {
		const original = tokenizeFlow.call(this, effects, ok, nok);
		const oneLine: Construct = { tokenize(checkEffects, checkOk, checkNok) {
			let line = ""; checkEffects.enter("mathFlowFenceMeta");
			const scan: State = (code) => {
				if (code === null || markdownLineEnding(code)) { checkEffects.exit("mathFlowFenceMeta"); return /^\$\$[^\n]+\$\$[ \t]*$/.test(line) ? checkOk(code) : checkNok(code); }
				line += code < 0 ? " " : String.fromCharCode(code); checkEffects.consume(code); return scan;
			};
			return scan;
		} };
		return effects.check(oneLine, nok, original);
	};
	const data = this.data();
	(data.micromarkExtensions ??= []).push(syntax, { text: { 36: githubInline } });
	(data.fromMarkdownExtensions ??= []).push(mathFromMarkdown());
};
