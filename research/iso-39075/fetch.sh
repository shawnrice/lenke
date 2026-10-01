#!/bin/sh
# Download ISO/IEC 39075's free "electronic inserts" into ./artifacts/ (gitignored).
#
# They are NOT committed: ISO's licence grants use "in their original format without any
# modifications", not redistribution. See README.md.
#
#   ./fetch.sh
set -eu

base='https://standards.iso.org/iso-iec/39075/ed-1/en'
dir="$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)"
out="$dir/artifacts"
mkdir -p "$out"

for f in \
  'ISO_IEC_39075(en).bnf.txt' \
  'ISO_IEC_39075(en).bnf.xml' \
  'ISO_IEC_39075(en)-features.xml' \
  'ISO_IEC_39075(en)-conditions.xml' \
  'ISO_IEC_39075(en)-implementation-defined.xml' \
  'ISO_IEC_39075(en)-implementation-dependent.xml'; do
  printf '%s ... ' "$f"
  if curl -fsS --max-time 120 "$base/$f" -o "$out/$f"; then
    printf '%s bytes\n' "$(wc -c <"$out/$f" | tr -d ' ')"
  else
    printf 'FAILED\n' >&2
    exit 1
  fi
done
