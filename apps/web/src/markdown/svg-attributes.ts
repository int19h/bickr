/**
 * Attribute schema of the inline SVG policy. Each permitted attribute has one
 * namespace and one value rule, and the DOMPurify allowlist derives from the
 * same table, so the two lists cannot drift apart.
 *
 * A rule parses the whole value. It rejects syntax outside its grammar, such
 * as a unit that the attribute does not take, because the policy must know
 * what it passes on. It does not enforce the semantic range of a value, such
 * as a negative radius or an opacity above one. Browsers ignore or clamp such
 * a value on that one attribute, which is harmless, while a rejection hides
 * the whole drawing. Numeric bounds exist only to keep values finite.
 *
 * Two rules are coarser than a grammar: path data checks its alphabet and its
 * numbers, and font-family checks its alphabet. Each parser scans its input
 * in linear time, because the policy runs synchronously before insertion.
 */
export const svgNamespace = "http://www.w3.org/2000/svg";
export const xlinkNamespace = "http://www.w3.org/1999/xlink";
const xmlNamespace = "http://www.w3.org/XML/1998/namespace";
const xmlnsNamespace = "http://www.w3.org/2000/xmlns/";

/** The magnitude ceiling of every number in a drawing. */
const valueBound = 1_000_000;

type Unit = "" | "px" | "%" | "em";
type Range = readonly [min: number, max: number];
type Units = Partial<Record<Unit, Range>>;

type ValueRule =
	| { kind: "length"; units: Units; keywords?: readonly string[] }
	/** A list counts as geometry when it can hold one item per character. */
	| { kind: "lengthList"; units: Units; maxItems: number; geometry: boolean; keywords?: readonly string[] }
	| { kind: "points" }
	| { kind: "viewBox" }
	/** CSS keywords match without regard to ASCII case. SVG attribute keywords match exactly. */
	| { kind: "keyword"; values: readonly string[]; css: boolean }
	| { kind: "fontWeight" }
	| { kind: "paint" }
	| { kind: "color" }
	| { kind: "fragmentUrl" }
	| { kind: "href" }
	| { kind: "idList" }
	| { kind: "path" }
	| { kind: "transform" }
	| { kind: "fontFamily" }
	| { kind: "aspectRatio" }
	| { kind: "paintOrder" }
	| { kind: "namespaceDeclaration"; value: string }
	| { kind: "id" }
	| { kind: "text"; maxLength: number };

type AttributeSpec = {
	namespace: string | null;
	rule: ValueRule;
	/** The rule on `text` and `tspan`, where some attributes take a list. */
	textRule?: ValueRule;
};

const any: Range = [-valueBound, valueBound];
const coordinate: Units = { "": any, px: any, "%": any };
/** Text positions also take em, which spaces lines by the font size. */
const textPosition: Units = { ...coordinate, em: any };
const fraction: Units = { "": any, "%": any };
const plainNumber: Units = { "": any };
const spacing: Units = { "": any, px: any, em: any };
/**
 * Relative font sizes compound through nesting and through `use`, so no cap
 * on one value bounds the computed size. The policy bounds each value only.
 */
const fontSize: Units = { ...coordinate, em: any };
const units = ["userSpaceOnUse", "objectBoundingBox"];
const baselineCompatibility = ["text-before-edge", "text-after-edge"];

function spec(rule: ValueRule, textRule?: ValueRule): AttributeSpec { return { namespace: null, rule, ...(textRule ? { textRule } : {}) }; }
const length = (u: Units, keywords?: readonly string[]): AttributeSpec => spec({ kind: "length", units: u, ...(keywords ? { keywords } : {}) });
const cssKeyword = (...values: string[]): AttributeSpec => spec({ kind: "keyword", values, css: true });
const svgKeyword = (...values: string[]): AttributeSpec => spec({ kind: "keyword", values, css: false });
const textPositions = (): AttributeSpec => spec({ kind: "length", units: coordinate }, { kind: "lengthList", units: textPosition, maxItems: 1024, geometry: true });

const attributes = {
	xmlns: { namespace: xmlnsNamespace, rule: { kind: "namespaceDeclaration", value: svgNamespace } },
	"xmlns:xlink": { namespace: xmlnsNamespace, rule: { kind: "namespaceDeclaration", value: xlinkNamespace } },
	"xml:space": { namespace: xmlNamespace, rule: { kind: "keyword", values: ["default", "preserve"], css: false } },
	id: spec({ kind: "id" }),
	role: svgKeyword("img"),
	"aria-label": spec({ kind: "text", maxLength: 1000 }),
	"aria-labelledby": spec({ kind: "idList" }),
	"aria-describedby": spec({ kind: "idList" }),
	viewBox: spec({ kind: "viewBox" }),
	preserveAspectRatio: spec({ kind: "aspectRatio" }),
	transform: spec({ kind: "transform" }),
	gradientTransform: spec({ kind: "transform" }),
	d: spec({ kind: "path" }),
	points: spec({ kind: "points" }),
	x: textPositions(), y: textPositions(), dx: textPositions(), dy: textPositions(),
	rotate: spec({ kind: "lengthList", units: plainNumber, maxItems: 1024, geometry: true }),
	x1: length(coordinate), y1: length(coordinate), x2: length(coordinate), y2: length(coordinate),
	cx: length(coordinate), cy: length(coordinate), r: length(coordinate), rx: length(coordinate, ["auto"]), ry: length(coordinate, ["auto"]),
	fx: length(coordinate), fy: length(coordinate), fr: length(coordinate),
	width: length(coordinate), height: length(coordinate),
	offset: length(fraction), pathLength: length(plainNumber), textLength: length(coordinate),
	opacity: length(fraction), "fill-opacity": length(fraction), "stroke-opacity": length(fraction), "stop-opacity": length(fraction),
	"stroke-width": length(coordinate), "stroke-dashoffset": length(coordinate), "stroke-miterlimit": length(plainNumber),
	"stroke-dasharray": spec({ kind: "lengthList", units: coordinate, maxItems: 64, geometry: false, keywords: ["none"] }),
	"font-size": length(fontSize),
	"letter-spacing": length(spacing, ["normal"]), "word-spacing": length(spacing, ["normal"]),
	"baseline-shift": length(coordinate, ["baseline", "sub", "super"]),
	fill: spec({ kind: "paint" }), stroke: spec({ kind: "paint" }),
	color: spec({ kind: "color" }), "stop-color": spec({ kind: "color" }),
	"clip-path": spec({ kind: "fragmentUrl" }), mask: spec({ kind: "fragmentUrl" }),
	href: spec({ kind: "href" }),
	"xlink:href": { namespace: xlinkNamespace, rule: { kind: "href" } },
	"font-family": spec({ kind: "fontFamily" }),
	"font-weight": spec({ kind: "fontWeight" }),
	"font-style": cssKeyword("normal", "italic", "oblique"),
	"text-anchor": cssKeyword("start", "middle", "end"),
	// Each baseline property takes the CSS Inline 3 keywords and the SVG 1.1
	// spellings that a current engine still implements. Chromium honors
	// before-edge and after-edge for alignment-baseline only.
	"dominant-baseline": cssKeyword("auto", "alphabetic", "ideographic", "middle", "central", "mathematical", "hanging", "text-top", "text-bottom", ...baselineCompatibility),
	"alignment-baseline": cssKeyword("auto", "baseline", "before-edge", "after-edge", "alphabetic", "ideographic", "middle", "central", "mathematical", "hanging", "text-top", "text-bottom", ...baselineCompatibility),
	"text-decoration": cssKeyword("none", "underline", "overline", "line-through"),
	direction: cssKeyword("ltr", "rtl"),
	// SVG 1.1 spellings still render in current engines.
	"writing-mode": cssKeyword("horizontal-tb", "vertical-rl", "vertical-lr", "lr", "lr-tb", "rl", "rl-tb", "tb", "tb-rl"),
	"paint-order": spec({ kind: "paintOrder" }),
	"fill-rule": cssKeyword("nonzero", "evenodd"), "clip-rule": cssKeyword("nonzero", "evenodd"),
	"stroke-linecap": cssKeyword("butt", "round", "square"), "stroke-linejoin": cssKeyword("miter", "round", "bevel"),
	"shape-rendering": cssKeyword("auto", "optimizeSpeed", "crispEdges", "geometricPrecision"),
	"vector-effect": cssKeyword("none", "non-scaling-stroke"),
	"color-interpolation": cssKeyword("auto", "sRGB", "linearRGB"),
	gradientUnits: svgKeyword(...units), clipPathUnits: svgKeyword(...units), maskUnits: svgKeyword(...units), maskContentUnits: svgKeyword(...units),
	spreadMethod: svgKeyword("pad", "reflect", "repeat"),
	lengthAdjust: svgKeyword("spacing", "spacingAndGlyphs"),
} satisfies Record<string, AttributeSpec>;

const specs: ReadonlyMap<string, AttributeSpec> = new Map(Object.entries(attributes));
export const svgAttributeNames: readonly string[] = [...specs.keys()];

/** Resolves the spec of an attribute node, or null when the policy forbids it. */
export function attributeSpec(attr: Attr): AttributeSpec | null {
	const found = specs.get(attr.name);
	return found && found.namespace === attr.namespaceURI ? found : null;
}

function ruleFor(found: AttributeSpec, element: Element): ValueRule {
	return found.textRule && (element.localName === "text" || element.localName === "tspan") ? found.textRule : found.rule;
}

export type ValueCheck =
	| { kind: "valid" }
	| { kind: "invalid"; reason: string }
	/**
	 * A local fragment reference. `drawsTarget` says whether the target adds
	 * its geometry where the reference appears, which labels do not.
	 */
	| { kind: "reference"; ids: readonly string[]; drawsTarget: boolean; rewrite: (prefixed: readonly string[]) => string };

/** XML whitespace. JavaScript `\s` also matches characters that SVG does not treat as separators. */
const whitespaceRun = /[\t\n\r ]+/;
function isXmlSpace(character: string | undefined): boolean { return character === " " || character === "\t" || character === "\n" || character === "\r"; }
/** ASCII case folding. CSS keywords ignore ASCII case only, so `K` (Kelvin sign) is not `k`. */
function asciiLower(value: string): string { return value.replace(/[A-Z]/g, (letter) => letter.toLowerCase()); }
function trimXml(value: string): string {
	let start = 0; let end = value.length;
	while (start < end && isXmlSpace(value[start])) start++;
	while (end > start && isXmlSpace(value[end - 1])) end--;
	return value.slice(start, end);
}

/**
 * The CSS number form, which every rule except path data uses. Browsers
 * ignore `1.` in SVG attributes too, although the SVG 1.1 grammar allows it.
 */
const numberSource = "[+-]?(?:\\d*\\.\\d+|\\d+)(?:[eE][+-]?\\d+)?";
const dimension = new RegExp(`^(${numberSource})(px|%|em)?$`, "i");
const cssNumber = new RegExp(`^${numberSource}$`);
const name = "[A-Za-z_][\\w.-]*";
const simpleName = new RegExp(`^${name}$`);

function finite(token: string, range: Range = any): boolean {
	const number = Number(token);
	return Number.isFinite(number) && number >= range[0] && number <= range[1];
}

/** Splits a CSS or SVG list: items separated by whitespace or by one comma. */
function listItems(value: string): string[] | null {
	const items: string[] = [];
	for (const part of value.split(",")) {
		const trimmed = trimXml(part);
		if (!trimmed) return null;
		items.push(...trimmed.split(whitespaceRun));
	}
	return items;
}

/**
 * Reads numbers where a sign or a decimal point can also end the previous
 * number, as in `10-5`. Each item records whether a separator preceded it.
 */
const numberAt = new RegExp(numberSource, "y");
function compactNumbers(value: string): { number: number; separated: boolean; text: string }[] | null {
	const numbers: { number: number; separated: boolean; text: string }[] = [];
	let index = 0; let separated = true;
	const skipSpace = () => { const start = index; while (isXmlSpace(value[index])) index++; return index > start; };
	skipSpace();
	while (index < value.length) {
		numberAt.lastIndex = index;
		const match = numberAt.exec(value);
		if (!match || !finite(match[0])) return null;
		numbers.push({ number: Number(match[0]), separated, text: match[0] });
		index = numberAt.lastIndex;
		separated = skipSpace();
		if (value[index] === ",") {
			index++; skipSpace(); separated = true;
			if (index === value.length) return null;
		}
	}
	return numbers.length ? numbers : null;
}

/** Transform arguments: both engines read every compact spelling. */
function transformNumbers(value: string): number[] | null {
	return compactNumbers(value)?.map((item) => item.number) ?? null;
}

/**
 * Point pairs. Both engines read a negative second coordinate that follows
 * the first directly, as in `10-5`, but Firefox reads no other compact form.
 * A separator must therefore precede every other number.
 */
function pointNumbers(value: string): number[] | null {
	const items = compactNumbers(value);
	if (!items || items.length % 2 !== 0) return null;
	return items.every((item, index) => item.separated || (index % 2 === 1 && item.text.startsWith("-"))) ? items.map((item) => item.number) : null;
}

/** Strict number lists, separated by whitespace or one comma. */
function plainNumbers(value: string): number[] | null {
	const items = listItems(value);
	return items?.every((item) => cssNumber.test(item) && finite(item)) ? items.map(Number) : null;
}

/** Browsers store viewBox and dimensions as 32-bit floats, so `1e-50` becomes zero. */
function positiveFloat(number: number): boolean { return Math.fround(number) > 0; }

/** Parses one length and returns its number, or null outside the allowed units. */
function parseLength(value: string, allowed: Units): { number: number; unit: Unit } | null {
	const match = dimension.exec(value);
	if (!match) return null;
	const unit = asciiLower(match[2] ?? "") as Unit;
	const range = allowed[unit];
	return range && finite(match[1]!, range) ? { number: Number(match[1]), unit } : null;
}

/** The positive size of a root `width` or `height` in user units, for the synthesized viewBox, or null. */
export function absoluteLength(value: string): number | null {
	const parsed = parseLength(trimXml(value), { "": any, px: any });
	return parsed && positiveFloat(parsed.number) ? parsed.number : null;
}

/** The four numbers of a valid viewBox, or null. */
function viewBoxNumbers(value: string): readonly [number, number, number, number] | null {
	const numbers = plainNumbers(value);
	return numbers?.length === 4 && positiveFloat(numbers[2]!) && positiveFloat(numbers[3]!) ? [numbers[0]!, numbers[1]!, numbers[2]!, numbers[3]!] : null;
}

function keywordIn(values: readonly string[], value: string, css: boolean): boolean {
	return css ? values.some((keyword) => asciiLower(keyword) === asciiLower(value)) : values.includes(value);
}

/**
 * The CSS named colors, `transparent` and `currentColor`. CSS system colors
 * such as `CanvasText` are left out: they depend on the viewer's theme, so a
 * drawing would differ between readers and its preview image.
 */
const namedColors = new Set(("aliceblue antiquewhite aqua aquamarine azure beige bisque black blanchedalmond blue blueviolet brown burlywood cadetblue chartreuse chocolate coral cornflowerblue cornsilk crimson cyan darkblue darkcyan darkgoldenrod darkgray darkgreen darkgrey darkkhaki darkmagenta darkolivegreen darkorange darkorchid darkred darksalmon darkseagreen darkslateblue darkslategray darkslategrey darkturquoise darkviolet deeppink deepskyblue dimgray dimgrey dodgerblue firebrick floralwhite forestgreen fuchsia gainsboro ghostwhite gold goldenrod gray green greenyellow grey honeydew hotpink indianred indigo ivory khaki lavender lavenderblush lawngreen lemonchiffon lightblue lightcoral lightcyan lightgoldenrodyellow lightgray lightgreen lightgrey lightpink lightsalmon lightseagreen lightskyblue lightslategray lightslategrey lightsteelblue lightyellow lime limegreen linen magenta maroon mediumaquamarine mediumblue mediumorchid mediumpurple mediumseagreen mediumslateblue mediumspringgreen mediumturquoise mediumvioletred midnightblue mintcream mistyrose moccasin navajowhite navy oldlace olive olivedrab orange orangered orchid palegoldenrod palegreen paleturquoise palevioletred papayawhip peachpuff peru pink plum powderblue purple rebeccapurple red rosybrown royalblue saddlebrown salmon sandybrown seagreen seashell sienna silver skyblue slateblue slategray slategrey snow springgreen steelblue tan teal thistle tomato turquoise violet wheat white whitesmoke yellow yellowgreen transparent currentcolor").split(" "));

const isNumber = (token: string) => cssNumber.test(token) && finite(token);
const isPercentage = (token: string) => token.endsWith("%") && isNumber(token.slice(0, -1));
const isAlpha = (token: string) => isNumber(token) || isPercentage(token);
const isHue = (token: string) => isNumber(token.replace(/(?:deg|grad|rad|turn)$/i, ""));

/**
 * CSS colors without CSS-wide keywords, variables or math: a named color, a
 * hex color, or an rgb() or hsl() function. The legacy comma syntax takes
 * three numbers or three percentages for rgb(), and percentages for the
 * saturation and lightness of hsl(). The space syntax takes either form in
 * each channel, and an optional alpha after a slash.
 */
function color(value: string): boolean {
	const trimmed = trimXml(value);
	// The earlier grammar accepted `inherit`, which only copies the parent value.
	if (asciiLower(trimmed) === "inherit" || namedColors.has(asciiLower(trimmed))) return true;
	if (/^#(?:[\da-f]{3,4}|[\da-f]{6}|[\da-f]{8})$/i.test(trimmed)) return true;
	const call = /^(rgba?|hsla?)\(([^()]*)\)$/i.exec(trimmed);
	if (!call) return false;
	const hsl = asciiLower(call[1]!).startsWith("h");
	const inner = call[2]!;
	if (inner.includes(",")) {
		const parts = inner.split(",").map(trimXml);
		if (parts.length !== 3 && parts.length !== 4) return false;
		const [first, second, third, alpha] = parts as [string, string, string, string | undefined];
		const channels = hsl
			? isHue(first) && isPercentage(second) && isPercentage(third)
			: [first, second, third].every(isNumber) || [first, second, third].every(isPercentage);
		return channels && (alpha === undefined || isAlpha(alpha));
	}
	const sections = inner.split("/").map(trimXml);
	if (sections.length > 2 || !sections[0]) return false;
	const channels = sections[0].split(whitespaceRun);
	const alpha = sections[1];
	if (channels.length !== 3) return false;
	const [first, second, third] = channels as [string, string, string];
	const valid = hsl ? isHue(first) && [second, third].every(isAlpha) : channels.every(isAlpha);
	return valid && (alpha === undefined || isAlpha(alpha));
}

const urlReference = new RegExp(`^url\\((?:#(${name}))\\)$`);
const hrefReference = new RegExp(`^#(${name})$`);
function fragment(value: string, pattern: RegExp): string | null {
	return pattern.exec(trimXml(value))?.[1] ?? null;
}

const transformArguments: Record<string, readonly number[]> = { matrix: [6], translate: [1, 2], scale: [1, 2], rotate: [1, 3], skewX: [1], skewY: [1] };
const transformFunction = /(matrix|translate|scale|rotate|skewX|skewY)[\t\n\r ]*\(([^()]*)\)/y;

/** Parses a transform list: functions separated by whitespace, by one comma, or by nothing. */
function transformList(value: string): boolean {
	const trimmed = trimXml(value);
	let index = 0;
	for (;;) {
		transformFunction.lastIndex = index;
		const match = transformFunction.exec(trimmed);
		if (!match) return false;
		const args = transformNumbers(match[2]!);
		if (!args || !transformArguments[match[1]!]!.includes(args.length)) return false;
		index = transformFunction.lastIndex;
		if (index === trimmed.length) return true;
		while (isXmlSpace(trimmed[index])) index++;
		if (trimmed[index] === ",") { index++; while (isXmlSpace(trimmed[index])) index++; }
	}
}

const pathAlphabet = /^[MmZzLlHhVvCcSsQqTtAa\d\t\n\r .,eE+\-]*$/;
/** Path data keeps the SVG number form, which allows `1.`. */
const pathNumberTokens = /[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?/g;
const cssWideKeywords = new Set(["inherit", "initial", "unset", "revert", "revert-layer", "revert-rule", "default"]);

/**
 * A comma-separated list of quoted or unquoted family names. A CSS-wide
 * keyword is valid only alone, and the earlier grammar accepted `inherit`
 * there. Only XML whitespace separates words, because DOMPurify trims other
 * spaces and would change what the check saw.
 */
function fontFamily(value: string): boolean {
	if (!/^[\p{Letter}\p{Number}\t\n\r ,'"_-]{1,150}$/u.test(value)) return false;
	const families = value.split(",").map((family) => asciiLower(trimXml(family)));
	if (families.length === 1 && families[0] === "inherit") return true;
	return families.every((family) => family !== "" && !cssWideKeywords.has(family));
}

function check(rule: ValueRule, value: string): ValueCheck {
	const valid: ValueCheck = { kind: "valid" };
	const invalid = (reason: string): ValueCheck => ({ kind: "invalid", reason });
	const trimmed = trimXml(value);
	switch (rule.kind) {
		case "length":
			return (rule.keywords && keywordIn(rule.keywords, trimmed, true)) || parseLength(trimmed, rule.units) ? valid : invalid("must be a bounded number");
		case "lengthList": {
			if (rule.keywords && keywordIn(rule.keywords, trimmed, true)) return valid;
			const items = listItems(value);
			return items && items.length <= rule.maxItems && items.every((item) => parseLength(item, rule.units)) ? valid : invalid("must contain bounded numbers");
		}
		case "points": {
			return pointNumbers(value) ? valid : invalid("must contain coordinate pairs");
		}
		case "viewBox":
			return viewBoxNumbers(value) ? valid : invalid("must contain four numbers with positive dimensions");
		case "keyword":
			return keywordIn(rule.values, trimmed, rule.css) ? valid : invalid("value is not supported");
		case "fontWeight":
			return keywordIn(["normal", "bold", "bolder", "lighter"], trimmed, true) || (cssNumber.test(trimmed) && finite(trimmed, [1, 1000])) ? valid : invalid("value is not supported");
		case "color":
			return color(value) ? valid : invalid("must be a color");
		case "paint": {
			if (asciiLower(trimmed) === "none" || color(value)) return valid;
			const id = fragment(value, urlReference);
			return id ? { kind: "reference", ids: [id], drawsTarget: true, rewrite: ([target]) => `url(#${target})` } : invalid("must be a color or a local gradient");
		}
		case "fragmentUrl": {
			if (asciiLower(trimmed) === "none") return valid;
			const id = fragment(value, urlReference);
			return id ? { kind: "reference", ids: [id], drawsTarget: true, rewrite: ([target]) => `url(#${target})` } : invalid("must use a local fragment reference");
		}
		case "href": {
			const id = fragment(value, hrefReference);
			return id ? { kind: "reference", ids: [id], drawsTarget: true, rewrite: ([target]) => `#${target}` } : invalid("must use a local fragment reference");
		}
		case "idList": {
			const ids = trimmed.split(whitespaceRun);
			return ids.every((id) => simpleName.test(id)) ? { kind: "reference", ids, drawsTarget: false, rewrite: (targets) => targets.join(" ") } : invalid("must list local IDs");
		}
		case "path": {
			if (!pathAlphabet.test(value)) return invalid("must be path data with bounded numbers");
			const tokens = value.match(pathNumberTokens) ?? [];
			// Nonempty path data needs a number, as the earlier rule required.
			return (value === "" || tokens.length > 0) && tokens.every((token) => finite(token)) ? valid : invalid("must be path data with bounded numbers");
		}
		case "transform":
			return transformList(value) ? valid : invalid("must be a list of transform functions");
		case "fontFamily":
			return fontFamily(value) ? valid : invalid("must be a list of font names");
		case "aspectRatio":
			return /^(?:none|x(?:Min|Mid|Max)Y(?:Min|Mid|Max))(?:[\t\n\r ]+(?:meet|slice))?$/.test(trimmed) ? valid : invalid("must be an alignment keyword with optional meet or slice");
		case "paintOrder": {
			if (asciiLower(trimmed) === "normal") return valid;
			const tokens = asciiLower(trimmed).split(whitespaceRun);
			return tokens.length <= 3 && new Set(tokens).size === tokens.length && tokens.every((token) => ["fill", "stroke", "markers"].includes(token)) ? valid : invalid("value is not supported");
		}
		case "namespaceDeclaration":
			return value === rule.value ? valid : invalid("must declare its standard namespace");
		case "id":
			return simpleName.test(value) ? valid : invalid("must be a simple name");
		case "text":
			return value.length <= rule.maxLength ? valid : invalid("exceeds the rendering limit");
	}
}

export function checkAttribute(found: AttributeSpec, element: Element, value: string): ValueCheck {
	return check(ruleFor(found, element), value);
}

/**
 * Bytes of an element's attributes that scale with drawn geometry. The
 * source budget and the reference expansion budget both use this count.
 */
export function attributeGeometryBytes(element: Element): number {
	let bytes = 0;
	for (const attr of Array.from(element.attributes)) {
		const found = attributeSpec(attr);
		if (!found) continue;
		const rule = ruleFor(found, element);
		if (rule.kind === "path" || rule.kind === "points" || (rule.kind === "lengthList" && rule.geometry)) bytes += attr.value.length;
	}
	return bytes;
}
