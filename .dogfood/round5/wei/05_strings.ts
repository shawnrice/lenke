// String manipulation: substring, split, length, concat, trim, replace.
// Every result verified against an independent JS computation, with special
// attention to astral (surrogate-pair), combining-mark, and CJK strings.
import { Graph } from '@lenke/core';
import { query } from '@lenke/gql';

const g = new Graph();

function chk(
  label: string,
  gqlExpr: string,
  jsExpected: unknown,
  params?: Record<string, unknown>,
) {
  let actual: unknown;
  try {
    actual = query(g, `RETURN ${gqlExpr} AS r`, params)[0].r;
  } catch (e) {
    console.log(`ERR  ${label}: ${(e as Error).message}`);
    return;
  }
  const a = JSON.stringify(actual);
  const e = JSON.stringify(jsExpected);
  console.log(`${a === e ? 'OK ' : 'FAIL'} ${label}  => ${a}${a === e ? '' : `  (expected ${e})`}`);
}

const emoji = 'Rocket 🚀 go'; // 🚀 = U+1F680, surrogate pair -> JS .length counts 2 units
const cafe = 'Café'; // precomposed é (1 unit)
const cjk = '数据库引擎'; // 5 CJK chars, all BMP (1 unit each)

console.log('=== char_length (UTF-16 units) ===');
chk('char_length emoji', `char_length('${emoji}')`, emoji.length); // 12 (🚀 counts as 2)
chk('char_length CJK', `char_length('${cjk}')`, cjk.length); // 5
chk('char_length café', `char_length('${cafe}')`, cafe.length); // 4

console.log('\n=== substring (1-based, UTF-16 units) ===');
// substring(str, start, len) 1-based.
chk('substring café 1,3', `substring('${cafe}', 1, 3)`, cafe.substring(0, 3)); // 'Caf'
// Emoji at units 8-9 ('Rocket 🚀 go'): index of 🚀 in JS = 7 (0-based). 1-based=8.
chk('substring emoji at rocket', `substring('${emoji}', 8, 2)`, emoji.substring(7, 9)); // '🚀'
// Slice THROUGH the surrogate pair -> lossy U+FFFD expected (documented divergence).
chk('substring emoji half (1 unit into pair)', `substring('${emoji}', 8, 1)`, '�');

console.log('\n=== split ===');
chk('split words', `split('a b c', ' ')`, ['a', 'b', 'c']);
chk('split CJK on empty (per-unit)', `split('${cjk}', '')`, Array.from(cjk)); // BMP so same as codepoints
// split('') on emoji -> splits the surrogate pair -> two U+FFFD (documented lossy).
chk('split emoji on empty', `split('🚀', '')`, ['�', '�']);

console.log('\n=== concatenation (|| operator) ===');
chk('concat ||', `'foo' || 'bar'`, 'foobar');
chk('concat with emoji', `'a' || '🚀' || 'b'`, 'a🚀b');

console.log('\n=== trim / btrim / ltrim / rtrim ===');
chk('trim', `trim('  hi  ')`, '  hi  '.trim());
chk('ltrim', `ltrim('  hi  ')`, '  hi  '.replace(/^\s+/, ''));
chk('rtrim', `rtrim('  hi  ')`, '  hi  '.replace(/\s+$/, ''));

console.log('\n=== replace ===');
chk('replace', `replace('a-b-c', '-', '_')`, 'a-b-c'.replaceAll('-', '_'));
chk('replace emoji', `replace('go 🚀 go', '🚀', 'X')`, 'go 🚀 go'.replaceAll('🚀', 'X'));

console.log('\n=== left / right ===');
chk('left', `left('hello', 2)`, 'hello'.slice(0, 2));
chk('right', `right('hello', 2)`, 'hello'.slice(-2));
chk('left cuts surrogate', `left('🚀x', 1)`, '�'); // half a pair -> U+FFFD

console.log('\n=== reverse (UTF-16 units, lossy on astral) ===');
chk('reverse ascii', `reverse('abc')`, 'cba');
chk('reverse CJK', `reverse('${cjk}')`, Array.from(cjk).reverse().join('')); // BMP fine
// reverse emoji: reversing UTF-16 units swaps surrogate halves -> lossy.
console.log('   reverse("a🚀b") =>', JSON.stringify(query(g, `RETURN reverse('a🚀b') AS r`)[0].r));
console.log(
  '   (JS String reverse of units would be:',
  JSON.stringify([...'a🚀b'.split('')].reverse().join('')),
  ')',
);

console.log('\n=== byte_length / octet_length ===');
chk('byte_length emoji (UTF-8 bytes)', `byte_length('${emoji}')`, Buffer.byteLength(emoji, 'utf8'));
chk('byte_length CJK', `byte_length('${cjk}')`, Buffer.byteLength(cjk, 'utf8'));

console.log('\n=== combining marks: NFC vs NFD ===');
const nfc = 'é'; // U+00E9, 1 unit
const nfd = 'é'; // e + combining acute, 2 units
chk('char_length precomposed é', `char_length('${nfc}')`, nfc.length); // 1
chk('char_length decomposed é', `char_length('${nfd}')`, nfd.length); // 2
// Are they equal as strings? (No normalization expected.)
console.log(
  '   nfc == nfd equality:',
  query(g, `RETURN '${nfc}' = '${nfd}' AS eq`)[0].eq,
  '(JS ===',
  nfc === nfd,
  ')',
);
