/* test.js — node-runnable unit tests for the pure core.
 * Usage: node test.js
 * These cover the real defects found while OCR-ing the 257-code screenshot,
 * so they double as regression tests for the variant ranker.
 */
const C = require('./src/core/codes.js');
const G = require('./src/core/garena.js');

let fail = 0;
let pass = 0;
const eq = (name, got, want) => {
  const a = JSON.stringify(got), b = JSON.stringify(want);
  if (a !== b) { console.log('FAIL', name, '\n  got ', a, '\n  want', b); fail += 1; }
  else { pass += 1; console.log('ok  ', name); }
};

console.log('── parseCodes ──');
const joined = C.parseCodes([
  'MOILOOT45', 'DFCRAFT427', 'DFSIXVIP888', 'ACESIXMAJOR',
  'MOILOOT45DFCRAFT427DFSIXVIP888ACESIXMAJOR',
  'DFWEEK237', 'SOLDFWIN360', 'DFWEEK237SOLDFWIN360',
].join('\n'));
eq('joined runs split and dedup', joined.codes.map((c) => c.code).sort(),
  ['ACESIXMAJOR', 'DFCRAFT427', 'DFSIXVIP888', 'DFWEEK237', 'MOILOOT45', 'SOLDFWIN360']);
eq('two joined lines detected', joined.unjoined, 2);
eq('21-char weapon code never split',
  C.parseCodes(['6KMEQNG00T99PRENQV488', 'DF', 'DFAM'].join('\n')).codes.some((c) => c.code === '6KMEQNG00T99PRENQV488'), true);

const weapon = C.parseCodes('AUG Assault Rifle-Chiến Trường Toàn Diện-6KFJKLO07BHIFPGO0COS7');
eq('weapon line yields code', weapon.codes[0].code, '6KFJKLO07BHIFPGO0COS7');
eq('weapon line keeps item hint', weapon.codes[0].hint, 'AUG Assault Rifle - Chiến Trường Toàn Diện');
eq('case-insensitive dedup', C.parseCodes('DFutw\ndfUTW\nDFUTW').codes.length, 1);
eq('space separated accepted', C.parseCodes('DFAMMO08 DFARMX46').codes.length, 2);
eq('junk rejected', C.parseCodes('ab\n@@@\nDFAMMO08').invalid.length, 2);
eq('zero-width stripped', C.parseCodes('DFAM\u200BMO08').codes[0].code, 'DFAMMO08');

console.log('── ocrVariants (regressions from the real run) ──');
eq('#60 DFUItra220 → DFUltra220 first', C.ocrVariants('DFUItra220', 8)[0], 'DFUltra220');
eq('#128 DFOS7K2M9Q offers ...M90 in top-2', C.ocrVariants('DFOS7K2M9Q', 8).slice(0, 2).includes('DFOS7K2M90'), true);
eq('#156 DFCCHAHA5 offers ...HAHAS in top-2', C.ocrVariants('DFCCHAHA5', 8).slice(0, 2).includes('DFCCHAHAS'), true);
eq('#215 offers gUei3bJy', C.ocrVariants('N4SQWgxYcHw7gUci3bJy', 8).includes('N4SQWgxYcHw7gUei3bJy'), true);
eq('brand prefix untouched in top-4', C.ocrVariants('DFULTRA220', 4).every((v) => v.slice(0, 2) === 'DF'), true);
eq('never returns the input', C.ocrVariants('DFULTRA220', 8).includes('DFULTRA220'), false);
eq('all variants are valid codes', C.ocrVariants('DFUItra220', 8).every(C.isCode), true);
eq('limit respected', C.ocrVariants('DFOS7K2M9Q', 3).length <= 3, true);

console.log('── classifyFamily ──');
eq('POC', C.classifyFamily('POC3105S96'), 'POC-dated');
eq('PWC', C.classifyFamily('PWC260419S84'), 'PWC-dated');
eq('DFSL', C.classifyFamily('DFSL8019'), 'DFSL-series');
eq('DFCC', C.classifyFamily('DFCCOPPL4Y3R5'), 'DFCC-campaign');
eq('weapon', C.classifyFamily('6KFJKLO07BHIFPGO0COS7'), 'weapon-longcode');
eq('random token', C.classifyFamily('ACUQJTXY7VXGJXCTBNQU'), 'random-token');
eq('DF word', C.classifyFamily('DFULTRA220'), 'DF-word');

console.log('── garena response contract ──');
eq('code 0 is a trusted success', ((x) => [x.status, x.trusted])(G.classifyResponse({ code: 0, msg: 'ok' })), ['SUCCESS', true]);
eq('400054 → INVALID', G.classifyResponse({ code: 400054, msg: 'cdk not match' }).status, 'INVALID');
eq('400067 → LIMIT_REACHED', G.classifyResponse({ code: 400067, msg: 'x' }).status, 'LIMIT_REACHED');
eq('400068 → EXPIRED', G.classifyResponse({ code: 400068, msg: 'x' }).status, 'EXPIRED');
eq('400073 → PRESENT_ERROR', G.classifyResponse({ code: 400073, msg: 'x' }).status, 'PRESENT_ERROR');
eq('missing body → untrusted NO_RESPONSE', ((x) => [x.status, x.trusted])(G.classifyResponse(null)), ['NO_RESPONSE', false]);
eq('page text is never trusted', G.classifyText('Thành công').trusted, false);
eq('unknown numeric code preserved', G.classifyResponse({ code: 499999, msg: 'weird' }).errorCode, 499999);
// Regression: throttling must never be reported as a verdict about the code.
eq('401009 → RATE_LIMITED', G.classifyResponse({ code: 401009, msg: 'too many requests' }).status, 'RATE_LIMITED');
eq('unknown 401xxx → RATE_LIMITED', G.classifyResponse({ code: 401777, msg: 'x' }).status, 'RATE_LIMITED');
eq('HTTP 429 beats body', G.classifyResponse({ code: 0, msg: 'success' }, 429).status, 'RATE_LIMITED');
eq('HTTP 503 is transient', G.classifyResponse(null, 503).status, 'RATE_LIMITED');
eq('HTTP 500 without body is transient', G.classifyResponse(null, 500).status, 'TEMP_ERROR');
eq('rate limit is retryable', G.RETRYABLE.has('RATE_LIMITED'), true);
eq('rate limit is not a real-code proof', G.CODE_IS_REAL.has('RATE_LIMITED'), false);
eq('redeem body recognised', G.looksLikeRedeemBody({ code: 0, msg: 'ok' }), true);
eq('unrelated xhr ignored', G.looksLikeRedeemBody({ foo: 1 }), false);
eq('INVALID triggers variant probing', G.VARIANT_WORTHY.has('INVALID'), true);
eq('LIMIT_REACHED proves code is real', G.CODE_IS_REAL.has('LIMIT_REACHED'), true);
eq('SUCCESS is not retryable', G.RETRYABLE.has('SUCCESS'), false);
eq('logout is fatal', G.FATAL.has('NOT_LOGGED_IN'), true);
eq('captcha is fatal', G.FATAL.has('VERIFY'), true);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
