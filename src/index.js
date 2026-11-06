import z from '@deepseek-ai/schemastery';
import { DEFAULTS, PRUNE_MARKER, ToolResultPruner } from '@deepseek-ai/dsh-compaction-tool-result-pruner';

// The block selection and validation follow DeepSeek Harness's
// dsh-compaction-tool-result-pruner (MIT):
// https://github.com/deepseek-ai/deepseek-harness
// Both paths count Unicode code points without allocating an array for the
// whole tool result. A lone surrogate counts as one code point, exactly as the
// upstream string iterator does.
const SURROGATE_PAIR = /[\uD800-\uDBFF][\uDC00-\uDFFF]/;

/**
 * One linear UTF-16 pass: code-point count plus whether the text contains any
 * valid surrogate pair. `paired` lets boundary lookup skip its scan entirely
 * when every UTF-16 unit is already one code point.
 */
function scanPoints(text) {
  let count = 0;
  let paired = false;
  for (let i = 0; i < text.length; i++, count++) {
    const unit = text.charCodeAt(i);
    if (unit >= 0xd800 && unit <= 0xdbff && i + 1 < text.length) {
      const next = text.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) { i++; paired = true; }
    }
  }
  return { length: count, paired };
}

/**
 * fastLength is the only switch that adds a probe: when a regular expression
 * finds no adjacent surrogate pair, UTF-16 length is already the code-point
 * count, so the linear pass is skipped. Text WITH pairs pays for the probe and
 * then still runs the full scan — measure this regression before enabling it.
 */
function analyze(text, fastLength) {
  if (fastLength && !SURROGATE_PAIR.test(text)) {
    return { length: text.length, paired: false };
  }
  return scanPoints(text);
}

// Convert a code-point boundary to a UTF-16 offset. With no valid pair in the
// block, offsets equal positions. Otherwise scan from the closer end. A
// boundary never splits a surrogate pair across separate blocks.
function pointOffset(text, position, length, paired) {
  if (position <= 0) return 0;
  if (position >= length) return text.length;
  if (!paired) return position;
  if (position <= length - position) {
    let offset = 0;
    for (let points = 0; points < position; points++) {
      const unit = text.charCodeAt(offset++);
      if (unit >= 0xd800 && unit <= 0xdbff && offset < text.length) {
        const next = text.charCodeAt(offset);
        if (next >= 0xdc00 && next <= 0xdfff) offset++;
      }
    }
    return offset;
  }
  let offset = text.length;
  for (let points = 0; points < length - position; points++) {
    const unit = text.charCodeAt(--offset);
    if (unit >= 0xdc00 && unit <= 0xdfff && offset > 0) {
      const previous = text.charCodeAt(offset - 1);
      if (previous >= 0xd800 && previous <= 0xdbff) offset--;
    }
  }
  return offset;
}

/** Replacement provider for the optional upstream toolResultPruner service. */
export class LeetAccelerator extends ToolResultPruner {
  static Config = z.object({
    enabled: z.boolean().default(false),
    fastLength: z.boolean().default(false),
    thresholdChars: z.number().step(1).min(1).default(DEFAULTS.thresholdChars),
    headChars: z.number().step(1).min(0).default(DEFAULTS.headChars),
    tailChars: z.number().step(1).min(0).default(DEFAULTS.tailChars),
  });

  constructor(ctx, options = {}) {
    const { enabled = false, fastLength = false, ...upstreamOptions } = options;
    if (typeof enabled !== 'boolean') throw new TypeError('enabled must be a boolean');
    if (typeof fastLength !== 'boolean') throw new TypeError('fastLength must be a boolean');
    super(ctx, upstreamOptions);
    this.enabled = enabled;
    this.fastLength = fastLength;
  }

  measureContent(blocks) {
    if (!this.enabled) return super.measureContent(blocks);
    let chars = 0;
    for (const block of blocks) if (block.type === 'text') chars += analyze(block.text, this.fastLength).length;
    return chars;
  }

  pruneContent(blocks) {
    if (!this.enabled) return super.pruneContent(blocks);
    const analyzed = blocks.map(block => block.type === 'text'
      ? analyze(block.text, this.fastLength)
      : { length: 0, paired: false });
    const totalChars = analyzed.reduce((sum, entry) => sum + entry.length, 0);
    if (totalChars <= this.config.thresholdChars) return null;

    const removedStart = this.config.headChars;
    const removedEnd = totalChars - this.config.tailChars;
    const pruned = [];
    let consumed = 0;
    let markerInserted = false;
    for (let i = 0; i < blocks.length; i++) {
      const block = blocks[i];
      if (block.type !== 'text') {
        pruned.push(block);
        continue;
      }
      const { length, paired } = analyzed[i];
      const blockStart = consumed;
      const blockEnd = blockStart + length;
      const headEnd = Math.min(length, Math.max(0, removedStart - blockStart));
      const tailStart = Math.min(length, Math.max(0, removedEnd - blockStart));
      const marker = blockStart < removedEnd && blockEnd > removedStart && !markerInserted ? PRUNE_MARKER : '';
      if (marker) markerInserted = true;
      const text = block.text.slice(0, pointOffset(block.text, headEnd, length, paired))
        + marker + block.text.slice(pointOffset(block.text, tailStart, length, paired));
      if (text.length > 0) pruned.push({ ...block, text });
      consumed = blockEnd;
    }
    if (!markerInserted) throw new Error('tool-result prune: failed to locate the removed text span');
    const charsAfter = this.measureContent(pruned);
    if (charsAfter > this.config.thresholdChars || charsAfter >= totalChars) {
      throw new Error('tool-result prune: replacement must be smaller and within threshold');
    }
    return pruned;
  }
}

export default LeetAccelerator;
