/**
 * Call-stack-scoped, structure-verified measurement cache.
 *
 * Upstream `pruneSession` measures the same content arrays several times: once
 * inside `pruneContent`, then again as `charsBefore` and `charsAfter`. A cache
 * keyed only by array identity would be fast but would silently assume nothing
 * mutates those arrays in between. This cache instead keeps an O(block-count)
 * structural snapshot and refuses a hit unless every block still has the same
 * `type` and the same `text` string reference.
 *
 * That check is sufficient: strings are immutable in JavaScript, and only text
 * blocks contribute code points. For primitive strings `===` compares values,
 * so an equal string always has the same code-point count; a boxed String
 * object compares by identity and is conservatively treated as a miss. If the
 * snapshot matches, the exact Unicode code-point total cannot have changed.
 * Pushing/splicing the array, replacing a block, flipping its type, or
 * assigning a different text all invalidate the entry. No assumption about
 * upstream behaviour is needed.
 *
 * The cache lives only for one synchronous `pruneSession` call; the owner
 * creates and disposes it in a try/finally.
 */

/**
 * @param {readonly object[]} blocks
 * @returns {Array<number|boolean|string|null>}
 */
function snapshot(blocks) {
  // Flat layout: [length, isText0, text0|null, isText1, text1|null, ...].
  // `type` is recorded explicitly so a non-text block cannot silently become
  // a text block without invalidating the entry.
  const out = [blocks.length];
  for (const block of blocks) {
    const isText = block.type === 'text';
    out.push(isText, isText ? block.text : null);
  }
  return out;
}

/**
 * @param {Array<number|boolean|string|null>} snap
 * @param {readonly object[]} blocks
 */
function matches(snap, blocks) {
  if (snap[0] !== blocks.length) return false;
  let i = 1;
  for (const block of blocks) {
    const isText = block.type === 'text';
    if (snap[i++] !== isText) return false;
    if (snap[i++] !== (isText ? block.text : null)) return false;
  }
  return true;
}

/**
 * Create an empty measurement cache.
 * @returns {{ get(blocks: readonly object[]): number|undefined,
 *             put(blocks: readonly object[], value: number): void }}
 */
export function createMetricsCache() {
  const entries = new WeakMap();
  return {
    get(blocks) {
      const entry = entries.get(blocks);
      if (!entry || !matches(entry.snapshot, blocks)) return undefined;
      return entry.value;
    },
    put(blocks, value) {
      entries.set(blocks, { value, snapshot: snapshot(blocks) });
    },
  };
}

export default createMetricsCache;
