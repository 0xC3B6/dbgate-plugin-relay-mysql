'use strict';

function buildRemoteScript() {
  return `#!/usr/bin/env bash
set -u
set -o pipefail
umask 077

nonce="\${1:-}"
case "$nonce" in
  ''|*[!A-Fa-f0-9-]*) exit 15 ;;
esac

original_stty="$(stty -g 2>/dev/null || true)"
stty -echo -onlcr -icanon min 1 time 0 2>/dev/null || true
marker="__DBGATE_RELAY_MYSQL_\${nonce}"
printf '%s_READY__\\n' "$marker"

read_frame() {
  local encoded
  IFS= read -r encoded || return 1
  printf '%s' "$encoded" | base64 -d
}

read_value() {
  local encoded
  IFS= read -r encoded || return 1
  decoded_frame="$(printf '%s' "$encoded" | base64 -d)" || return 1
}

read_value || exit 15
mysql_command="$decoded_frame"
read_value || exit 15
mysql_host="$decoded_frame"
read_value || exit 15
mysql_port="$decoded_frame"
read_value || exit 15
mysql_user="$decoded_frame"
read_value || exit 15
mysql_password="$decoded_frame"
read_value || exit 15
database="$decoded_frame"
read_value || exit 15
sql_chunk_count="$decoded_frame"
case "$sql_chunk_count" in
  ''|*[!0-9]*) exit 15 ;;
esac

error_file="$(mktemp "\${TMPDIR:-/tmp}/dbgate-relay-error.XXXXXX")" || {
  exit 15
}
cleanup() {
  if [ -n "$original_stty" ]; then
    stty "$original_stty" 2>/dev/null || true
  fi
  rm -f "$error_file"
}
trap cleanup EXIT HUP INT TERM

mysql_args=(
  --xml
  --quick
  --binary-mode
  --host="$mysql_host"
  --port="$mysql_port"
  --user="$mysql_user"
  "--init-command=SET SESSION TRANSACTION READ ONLY"
)
if [ -n "$database" ]; then
  mysql_args+=(--database="$database")
fi

printf '%s_XML_BEGIN__\\n' "$marker"
(
  chunk_index=0
  while [ "$chunk_index" -lt "$sql_chunk_count" ]; do
    read_frame || exit 15
    chunk_index=$((chunk_index + 1))
  done
) | MYSQL_PWD="$mysql_password" "$mysql_command" "\${mysql_args[@]}" 2>"$error_file"
mysql_status=$?
unset mysql_password
printf '\\n%s_XML_END__\\n' "$marker"

if [ "$mysql_status" -eq 0 ]; then
  printf '%s_STATUS__OK\\n' "$marker"
  exit 0
fi

category=sql_error
if [ "$mysql_status" -eq 126 ] || [ "$mysql_status" -eq 127 ] || \
   grep -Eqi 'ERROR (1045|2002|2003|2005)|access denied|can.not connect|unknown mysql server host' "$error_file"; then
  category=mysql_connection
fi
printf '%s_ERROR__%s\\n' "$marker" "$category"
exit 0
`;
}

module.exports = { buildRemoteScript };
