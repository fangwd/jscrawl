import { thrownFinding } from '../src/core/issues';

const throwFrom = (message: string) => {
  try {
    JSON.parse(message);
  } catch (err) {
    return thrownFinding(err);
  }
  throw new Error('expected JSON.parse to throw');
};

test('a thrown error is coded by its class and the project line it passed through, whatever its message', () => {
  const first = throwFrom('{oops');
  const second = throwFrom('<html>');
  expect(first.code).toMatch(/^SyntaxError at test\/issues\.test\.ts:\d+$/);
  expect(second.code).toBe(first.code);
  expect(second.detail).not.toBe(first.detail);
});

test('a thrown non-error has no class or line to code it by', () => {
  expect(thrownFinding('timed out')).toEqual({
    code: 'thrown',
    detail: 'timed out',
  });
});
