/**
 * dsh-windows-caption-safe — Host half.
 *
 * The bundle carries no Host behaviour: the browser module publishes the caption
 * safe-area contract and realigns the surfaces under it. `apply` exists only
 * because the Loader requires a Host entry for every inserted row.
 *
 * @see ./client.js for the engine and the rule set.
 */

/**
 * @param {import('@deepseek-ai/cordis').Context} _ctx - the Host plugin context.
 * @param {unknown} _config - the row's config, from `cordis.patch.yml`.
 */
export function apply(_ctx, _config) {}
