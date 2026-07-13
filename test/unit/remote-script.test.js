'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildRemoteScript } = require('../../src/runner/remote-script');

test('remote script uses fixed read-only mysql XML invocation', () => {
  const script = buildRemoteScript();
  assert.match(script, /--xml/);
  assert.match(script, /--quick/);
  assert.match(script, /--binary-mode/);
  assert.match(script, /SET SESSION TRANSACTION READ ONLY/);
  assert.match(script, /MYSQL_PWD="\$mysql_password"/);
  assert.match(script, /while \[ "\$chunk_index" -lt "\$sql_chunk_count" \]/);
});

test('remote script disables terminal echo before requesting secret frames', () => {
  const script = buildRemoteScript();
  assert.match(script, /original_stty="\$\(stty -g/);
  assert.ok(script.indexOf('stty -echo') < script.indexOf('mysql_password="$decoded_frame"'));
  assert.match(script, /stty "\$original_stty"/);
  assert.doesNotMatch(script, /result_file|dbgate-relay-result/);
  assert.doesNotMatch(script, /select 1|example-password/i);
});

test('remote script emits nonce-scoped markers and never returns raw mysql stderr', () => {
  const script = buildRemoteScript();
  assert.match(script, /_XML_BEGIN__/);
  assert.match(script, /_XML_END__/);
  assert.match(script, /_ERROR__%s/);
  assert.doesNotMatch(script, /cat "\$error_file"/);
});
