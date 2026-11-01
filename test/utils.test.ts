import { trimTitle } from '../src/core/utils';

test('trimTitle', () => {
  expect(trimTitle(' foo  bar ')).toBe('foo bar');
  expect(trimTitle(' foo , bar  blah')).toBe('foo, bar blah');
});
