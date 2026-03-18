type SegmentKind =
  | 'code'
  | 'single-quote'
  | 'double-quote'
  | 'backtick-quote'
  | 'bracket-identifier'
  | 'line-comment'
  | 'block-comment';

interface SqlSegment {
  kind: SegmentKind;
  text: string;
}

/**
 * Split SQL into code vs literal/comment segments so rewrites only touch SQL tokens.
 */
export function splitSqlSegments(sql: string): SqlSegment[] {
  const segments: SqlSegment[] = [];

  let state: SegmentKind = 'code';
  let segmentStart = 0;
  let index = 0;

  const pushSegment = (endExclusive: number): void => {
    if (endExclusive <= segmentStart) {
      return;
    }

    segments.push({
      kind: state,
      text: sql.slice(segmentStart, endExclusive),
    });
  };

  while (index < sql.length) {
    const current = sql[index];
    const next = sql[index + 1] ?? '';

    if (state === 'code') {
      if (current === '-' && next === '-') {
        pushSegment(index);
        state = 'line-comment';
        segmentStart = index;
        index += 2;
        continue;
      }

      if (current === '/' && next === '*') {
        pushSegment(index);
        state = 'block-comment';
        segmentStart = index;
        index += 2;
        continue;
      }

      if (current === "'") {
        pushSegment(index);
        state = 'single-quote';
        segmentStart = index;
        index += 1;
        continue;
      }

      if (current === '"') {
        pushSegment(index);
        state = 'double-quote';
        segmentStart = index;
        index += 1;
        continue;
      }

      if (current === '`') {
        pushSegment(index);
        state = 'backtick-quote';
        segmentStart = index;
        index += 1;
        continue;
      }

      if (current === '[') {
        pushSegment(index);
        state = 'bracket-identifier';
        segmentStart = index;
        index += 1;
        continue;
      }

      index += 1;
      continue;
    }

    if (state === 'line-comment') {
      if (current === '\n') {
        index += 1;
        pushSegment(index);
        state = 'code';
        segmentStart = index;
        continue;
      }

      index += 1;
      continue;
    }

    if (state === 'block-comment') {
      if (current === '*' && next === '/') {
        index += 2;
        pushSegment(index);
        state = 'code';
        segmentStart = index;
        continue;
      }

      index += 1;
      continue;
    }

    if (state === 'single-quote') {
      if (current === "'" && next === "'") {
        index += 2;
        continue;
      }

      if (current === "'") {
        index += 1;
        pushSegment(index);
        state = 'code';
        segmentStart = index;
        continue;
      }

      index += 1;
      continue;
    }

    if (state === 'double-quote') {
      if (current === '"' && next === '"') {
        index += 2;
        continue;
      }

      if (current === '"') {
        index += 1;
        pushSegment(index);
        state = 'code';
        segmentStart = index;
        continue;
      }

      index += 1;
      continue;
    }

    if (state === 'backtick-quote') {
      if (current === '`' && next === '`') {
        index += 2;
        continue;
      }

      if (current === '`') {
        index += 1;
        pushSegment(index);
        state = 'code';
        segmentStart = index;
        continue;
      }

      index += 1;
      continue;
    }

    // bracket identifier
    if (current === ']' && next === ']') {
      index += 2;
      continue;
    }

    if (current === ']') {
      index += 1;
      pushSegment(index);
      state = 'code';
      segmentStart = index;
      continue;
    }

    index += 1;
  }

  if (segmentStart < sql.length) {
    pushSegment(sql.length);
  }

  return segments;
}

export function mapSqlCodeSegments(
  sql: string,
  mapper: (code: string) => string,
): string {
  const segments = splitSqlSegments(sql);

  return segments
    .map((segment) => {
      if (segment.kind === 'code') {
        return mapper(segment.text);
      }

      return segment.text;
    })
    .join('');
}

