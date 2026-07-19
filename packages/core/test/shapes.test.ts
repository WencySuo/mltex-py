import { describe, expect, it } from 'vitest';
import {
  einsumDeclaredShapes,
  parseDimString,
  parseEinopsInputShape,
  parseEinsumSpec,
  parseJaxtypingAnnotation,
  parseShapeComment,
} from '../src/translate/shapes.js';

describe('parseDimString (jaxtyping grammar core)', () => {
  const good: Array<[string, Array<string | number>]> = [
    ['b s d', ['b', 's', 'd']],
    ['batch seq 128', ['batch', 'seq', 128]],
    ['*batch d', ['*batch', 'd']],
    ['#b s', ['#b', 's']],
    ['...', ['...']],
    ['... d', ['...', 'd']],
    ['*#b d', ['*#b', 'd']],
    ['n=3 d', ['n', 'd']],
    ['', []],
  ];
  it.each(good)('"%s" → %j', (s, dims) => {
    expect(parseDimString(s)).toEqual(dims);
  });

  const bad = ['dim-1 d', 'a+b', 'd/2'];
  it.each(bad)('"%s" → unparseable (undefined)', (s) => {
    expect(parseDimString(s)).toBeUndefined();
  });
});

describe('parseJaxtypingAnnotation', () => {
  it('Float[Tensor, "b s d"]', () => {
    expect(parseJaxtypingAnnotation('Float[Tensor, "b s d"]')).toEqual({
      dims: ['b', 's', 'd'],
      dtype: 'float',
    });
  });
  it('module-prefixed and dtype variants', () => {
    expect(parseJaxtypingAnnotation('jaxtyping.Int32[np.ndarray, "n"]')).toEqual({
      dims: ['n'],
      dtype: 'int32',
    });
  });
  it('unparseable dim string → raw', () => {
    const r = parseJaxtypingAnnotation('Float[Tensor, "dim-1 d"]');
    expect(r?.raw).toBe('dim-1 d');
    expect(r?.dims).toEqual([]);
  });
  it('non-jaxtyping annotations → undefined', () => {
    expect(parseJaxtypingAnnotation('torch.Tensor')).toBeUndefined();
    expect(parseJaxtypingAnnotation('List[int]')).toBeUndefined();
    expect(parseJaxtypingAnnotation('Dict[str, "x"]')).toBeUndefined();
  });
});

describe('parseShapeComment', () => {
  it('(B, T, D) and mixed ints', () => {
    expect(parseShapeComment('(B, T, D)')).toEqual({ dims: ['B', 'T', 'D'] });
    expect(parseShapeComment('(batch, 128)')).toEqual({ dims: ['batch', 128] });
    expect(parseShapeComment('shape: (n, m)')).toEqual({ dims: ['n', 'm'] });
  });
  it('non-shape comments → undefined', () => {
    expect(parseShapeComment('TODO fix this')).toBeUndefined();
    expect(parseShapeComment('(see above)')).toBeUndefined();
    expect(parseShapeComment('()')).toBeUndefined();
  });
});

describe('parseEinsumSpec', () => {
  it('explicit output', () => {
    expect(parseEinsumSpec('ij,jk->ik')).toEqual({
      operands: [['i', 'j'], ['j', 'k']],
      output: ['i', 'k'],
      summed: ['j'],
    });
  });
  it('implicit output (numpy rules)', () => {
    expect(parseEinsumSpec('ij,jk')).toEqual({
      operands: [['i', 'j'], ['j', 'k']],
      output: ['i', 'k'],
      summed: ['j'],
    });
  });
  it('space-separated einops names', () => {
    expect(parseEinsumSpec('b i j, b j k -> b i k')?.summed).toEqual(['j']);
  });
  it('full contraction and trace', () => {
    expect(parseEinsumSpec('i,i->')?.summed).toEqual(['i']);
    expect(parseEinsumSpec('ii->')?.summed).toEqual(['i']);
  });
  it('ellipsis → undefined (documented core only)', () => {
    expect(parseEinsumSpec('...ij,...jk->...ik')).toBeUndefined();
  });
  it('einsumDeclaredShapes exposes operand + result dims', () => {
    const spec = parseEinsumSpec('ij,jk->ik')!;
    const shapes = einsumDeclaredShapes(spec);
    expect(shapes.operands[0]!.dims).toEqual(['i', 'j']);
    expect(shapes.result.dims).toEqual(['i', 'k']);
  });
});

describe('parseEinopsInputShape', () => {
  it('rearrange input pattern is a declaration', () => {
    expect(parseEinopsInputShape('b s d -> (b s) d')).toEqual({ dims: ['b', 's', 'd'] });
  });
  it('grouped/complex LHS → undefined', () => {
    expect(parseEinopsInputShape('(b s) d -> b s d')).toBeUndefined();
  });
});
