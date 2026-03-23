import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { computeMedian, detectOutlier } from './oracle.js';

describe('computeMedian', () => {
  it('returns the middle value for odd-length arrays', () => {
    assert.equal(computeMedian([1, 3, 5]), 3);
    assert.equal(computeMedian([10, 20, 30]), 20);
  });

  it('returns average of two middle values for even-length arrays', () => {
    assert.equal(computeMedian([1, 2, 3, 4]), 2.5);
    assert.equal(computeMedian([100, 200]), 150);
  });

  it('handles single value', () => {
    assert.equal(computeMedian([42]), 42);
  });

  it('handles empty array', () => {
    assert.equal(computeMedian([]), 0);
  });

  it('handles unsorted input', () => {
    assert.equal(computeMedian([5, 1, 3]), 3);
    assert.equal(computeMedian([2000, 2100, 1900]), 2000);
  });

  it('does not mutate original array', () => {
    const arr = [3, 1, 2];
    computeMedian(arr);
    assert.deepEqual(arr, [3, 1, 2]);
  });

  it('handles real price scenarios (tight spread)', () => {
    const prices = [2064.23, 2064.22, 2065.19];
    const median = computeMedian(prices);
    assert.equal(median, 2064.23);
  });
});

describe('detectOutlier', () => {
  it('returns no outlier for tight prices', () => {
    const prices = [2064.23, 2064.22, 2065.19];
    const median = computeMedian(prices);
    const result = detectOutlier(prices, median);
    assert.equal(result.outlierDetected, false);
  });

  it('detects outlier when one source diverges >2%', () => {
    const prices = [2000, 2001, 2100];
    const median = computeMedian(prices);
    const result = detectOutlier(prices, median);
    assert.equal(result.outlierDetected, true);
    assert(result.maxDeviation > 2);
  });

  it('handles zero median', () => {
    const result = detectOutlier([0, 0], 0);
    assert.equal(result.outlierDetected, false);
  });

  it('handles single source', () => {
    const result = detectOutlier([2000], 2000);
    assert.equal(result.outlierDetected, false);
  });

  it('returns exact deviation percentage', () => {
    // 100 is 100% off from median of 50
    const result = detectOutlier([0, 100], 50);
    assert.equal(result.outlierDetected, true);
    assert.equal(result.maxDeviation, 100);
  });
});

describe('price encoding', () => {
  it('encodes price with 8 decimals correctly', () => {
    const price = 2064.23;
    const encoded = BigInt(Math.round(price * 1e8));
    assert.equal(encoded, 206423000000n);
  });

  it('encodes sub-dollar prices correctly', () => {
    const price = 0.5432;
    const encoded = BigInt(Math.round(price * 1e8));
    assert.equal(encoded, 54320000n);
  });

  it('encodes large prices correctly', () => {
    const price = 68675.00;
    const encoded = BigInt(Math.round(price * 1e8));
    assert.equal(encoded, 6867500000000n);
  });
});
