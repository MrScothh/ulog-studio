import { saveBytes } from '../app/platform';
import { PARAM_META } from '../core/px4';

/** Write a QGroundControl-compatible .params file with the given values (loaded manually in QGC; never sent automatically). */
export function exportParams(values: [string, number][], fileName: string) {
  const lines = [
    '# Proposed parameters exported by ULog Studio — review before loading in QGroundControl',
    '#',
    '# Vehicle-Id Component-Id Name Value Type',
    ...values.map(([n, v]) => {
      const isInt = PARAM_META[n]?.t === 'INT32';
      return `1\t1\t${n}\t${isInt ? Math.round(v) : v.toFixed(18)}\t${isInt ? 6 : 9}`;
    }),
  ];
  void saveBytes(lines.join('\n') + '\n', fileName, 'text/plain');
}
