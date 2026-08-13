/**
 * Structural markers for text-selection capture.
 *
 * Spotlight prefill has to interpret rendered thread markup: which text belongs
 * to which comment, where the visual line breaks are, which markup is chrome
 * rather than content, and which regions are Spotlight's own UI. Presentational
 * class names are not a contract and change with styling work, so producers
 * carry explicit data attributes and the capture adapter matches only these.
 */

/** Holds one comment's text. The attribute value is that comment's id. */
export const commentBodyAttribute = "data-comment-body";
export const commentBodySelector = `[${commentBodyAttribute}]`;

/**
 * One rendered visual line. Comment bodies render each source line as its own
 * block element for bidi isolation, so serialization has to rejoin consecutive
 * line elements with newlines to reproduce what the reader sees.
 */
export const textLineAttribute = "data-text-line";

/**
 * Markup that must never reach quoted text: reference popups, hover metadata,
 * and layout filler that exists only to give an empty line its height.
 */
export const selectionExcludeAttribute = "data-selection-exclude";
export const selectionExcludeValue = "true";

/**
 * Spotlight's own panel. A selection inside it — editing the focus field, for
 * instance — is not the reader replacing their thread selection.
 */
export const spotlightUiAttribute = "data-spotlight-ui";

/** A Spotlight target checkbox: activating one consumes the retained capture. */
export const spotlightToggleAttribute = "data-spotlight-toggle";

/**
 * Everything Spotlight owns. An activation inside this region belongs to the
 * capture/consume cycle; an activation anywhere else retires the capture.
 */
export const spotlightRegionSelector = `[${spotlightUiAttribute}],[${spotlightToggleAttribute}]`;
